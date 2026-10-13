"""The hub: keeps everyone's public key and channel memberships, relays signed notes, and keeps them for later reading."""

import asyncio
import hmac
import logging
import re
import sqlite3
import threading
import time
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import Annotated, override

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from pydantic import StringConstraints
from pydantic_settings import BaseSettings, SettingsConfigDict

from deskmate.repos import is_under, prefix_key
from deskmate.wire import ChannelInfo, Delivered, HubInfo, Join, Name, Note, Person, Receipt, Repo, RepoRef, TeamRepo, User, auth_claim, auth_is_valid, is_channel, is_fresh, note_is_authentic

log = logging.getLogger(__name__)

MAX_WAIT = 30.0  # Longest a client may hold one long-poll open, in seconds.
PAGE = 100
HISTORY = 500  # Most notes one `tail` request may ask for.

MAX_REPOS = 500  # Most checkouts one person may advertise.
SCHEMA_VERSION = 3

SCHEMA = """
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, pubkey TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS members (channel TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY (channel, user));
CREATE TABLE IF NOT EXISTS pins (channel TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos (user TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL, branch TEXT NOT NULL, PRIMARY KEY (user, name));
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    ts INTEGER NOT NULL,
    agent TEXT,
    re INTEGER,
    sig TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS notes_by_recipient ON notes (recipient, id);
CREATE INDEX IF NOT EXISTS notes_by_sender ON notes (sender, id);
"""

INSTALLER = """#!/usr/bin/env bash
# deskmate client installer. Usage: curl -fsSL __HUB__/install.sh | bash -s -- <your-name> <join-token>
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: curl -fsSL __HUB__/install.sh | bash -s -- <your-name> <join-token>" >&2; exit 2; }
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install --quiet --force "git+https://github.com/jacobragsdale/deskmate"
deskmate join "__HUB__" "$1" "$2"
echo "Run 'deskmate' to open the chat. Your agents are the repos under ~/dev."
"""


_STANDARD_RECORD_FIELDS = frozenset(vars(logging.LogRecord("", 0, "", 0, "", (), None))) | {"message", "asctime"}


class _KeyValueFormatter(logging.Formatter):
    """Append the `extra=` fields, which the stock formatter silently drops."""

    @override
    def format(self, record: logging.LogRecord) -> str:
        extras = " ".join(f"{key}={value}" for key, value in vars(record).items() if key not in _STANDARD_RECORD_FIELDS)
        return f"{super().format(record)} {extras}".rstrip()


class HubSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DESKMATE_", strict=True, extra="forbid", frozen=True, validate_default=True, revalidate_instances="always", allow_inf_nan=False)

    join_token: Annotated[str, StringConstraints(min_length=16)]
    db: Path
    repos: Annotated[str, StringConstraints(min_length=1)]  # The URL the team's repos live under; only those may be shared.


def create_app(settings: HubSettings, now: Callable[[], float] = time.time) -> FastAPI:  # noqa: C901 -- one closure holds the routes; each route is simple on its own
    arrived = threading.Condition()
    prefix = prefix_key(settings.repos)

    def connect() -> sqlite3.Connection:
        return sqlite3.connect(settings.db, timeout=5)

    def pubkey_of(name: str) -> str | None:
        with closing(connect()) as conn:
            row: tuple[str] | None = conn.execute("SELECT pubkey FROM users WHERE name = ?", (name,)).fetchone()
        return row[0] if row else None

    def channel_info(channel: str) -> ChannelInfo:
        with closing(connect()) as conn:
            members: list[tuple[str]] = conn.execute("SELECT user FROM members WHERE channel = ? ORDER BY user", (channel,)).fetchall()
            pin: tuple[str, str, str] | None = conn.execute("SELECT name, key, url FROM pins WHERE channel = ?", (channel,)).fetchone()
        return ChannelInfo(name=channel, members=tuple(user for (user,) in members), repo=RepoRef(name=pin[0], key=pin[1], url=pin[2]) if pin else None)

    def member_of(name: str, me: str) -> str:
        """The channel's full name, once the caller is confirmed to be in it."""
        channel = f"#{name}"
        if me not in channel_info(channel).members:
            raise HTTPException(status_code=403, detail=f"join {channel} first")
        return channel

    def shareable(repo: RepoRef) -> None:
        if not is_under(repo.key, prefix):
            raise HTTPException(status_code=422, detail=f"{repo.name} is not under {prefix}, so this hub does not share it")

    def init_db() -> None:
        with closing(connect()) as conn:
            (version,) = conn.execute("PRAGMA user_version").fetchone()
            (tables,) = conn.execute("SELECT count(*) FROM sqlite_master WHERE type = 'table'").fetchone()
            if tables and version != SCHEMA_VERSION:
                msg = f"{settings.db} was made by another version of deskmate (schema {version}, this one uses {SCHEMA_VERSION}); start with an empty database"
                raise RuntimeError(msg)
            conn.executescript(f"{SCHEMA}PRAGMA user_version = {SCHEMA_VERSION};")

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        await asyncio.to_thread(init_db)
        log.info("hub ready", extra={"db": str(settings.db), "repos": prefix})
        yield

    app = FastAPI(title="deskmate hub", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def caller(authorization: Annotated[str, Header()] = "") -> str:
        claim = auth_claim(authorization)
        pubkey = pubkey_of(claim[0]) if claim else None
        if claim is None or pubkey is None or not auth_is_valid(*claim, pubkey=pubkey, now=now()):
            raise HTTPException(status_code=401, detail="not signed by a known user, or your clock is more than 5 minutes off")
        with closing(connect()) as conn, conn:
            conn.execute("UPDATE users SET seen = ? WHERE name = ?", (int(now()), claim[0]))  # Every signed request doubles as "I am here".
        return claim[0]

    @app.get("/healthz")
    def healthz() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/install.sh", response_class=PlainTextResponse)
    def installer(request: Request) -> str:
        hub = str(request.base_url).rstrip("/")
        if not re.fullmatch(r"https?://[A-Za-z0-9.\-:\[\]/_]+", hub):  # It is pasted into a shell script, so only plain URL characters pass.
            raise HTTPException(status_code=400, detail="unsupported host header")
        return INSTALLER.replace("__HUB__", hub)

    @app.post("/join", status_code=201)
    def join(req: Join) -> User:
        if not hmac.compare_digest(req.token.encode(), settings.join_token.encode()):
            raise HTTPException(status_code=403, detail="wrong join token")
        with closing(connect()) as conn, conn:
            conn.execute("INSERT OR IGNORE INTO users (name, pubkey) VALUES (?, ?)", (req.name, req.pubkey))
        if pubkey_of(req.name) != req.pubkey:
            raise HTTPException(status_code=409, detail=f"the name {req.name!r} is taken by another key")
        log.info("user joined", extra={"user": req.name})
        return User(name=req.name, pubkey=req.pubkey)

    @app.get("/info", dependencies=[Depends(caller)])
    def info() -> HubInfo:
        return HubInfo(repos=prefix)

    @app.get("/users", dependencies=[Depends(caller)])
    def users() -> list[Person]:
        with closing(connect()) as conn:
            rows: list[tuple[str, str, int]] = conn.execute("SELECT name, pubkey, seen FROM users ORDER BY name").fetchall()
        return [Person(name=name, pubkey=pubkey, seen=seen) for name, pubkey, seen in rows]

    @app.put("/repos")
    def put_repos(mine: Annotated[list[Repo], Body(max_length=MAX_REPOS)], me: Annotated[str, Depends(caller)]) -> list[Repo]:
        """Replace the list of repos the caller has checked out."""
        for repo in mine:
            shareable(repo)
        if len({repo.name for repo in mine}) != len(mine):
            raise HTTPException(status_code=422, detail="two repos share a name")
        with closing(connect()) as conn, conn:
            conn.execute("DELETE FROM repos WHERE user = ?", (me,))
            conn.executemany("INSERT INTO repos (user, name, key, url, branch) VALUES (?, ?, ?, ?, ?)", [(me, repo.name, repo.key, repo.url, repo.branch) for repo in mine])
        return mine

    @app.get("/repos", dependencies=[Depends(caller)])
    def get_repos() -> list[TeamRepo]:
        with closing(connect()) as conn:
            rows: list[tuple[str, str, str, str, str]] = conn.execute("SELECT user, name, key, url, branch FROM repos ORDER BY name, user").fetchall()
        return [TeamRepo(user=user, name=name, key=key, url=url, branch=branch) for user, name, key, url, branch in rows]

    @app.post("/notes", status_code=201)
    def post_note(note: Note) -> Receipt:
        pubkey = pubkey_of(note.sender)
        if pubkey is None or not note_is_authentic(note, pubkey):
            raise HTTPException(status_code=401, detail="note is not signed by its sender")
        if not is_fresh(note.ts, now()):
            raise HTTPException(status_code=400, detail="note timestamp is more than 5 minutes off the hub clock; check your system time")
        if is_channel(note.to):
            if note.sender not in channel_info(note.to).members:
                raise HTTPException(status_code=403, detail=f"join {note.to} before posting to it")
        elif pubkey_of(note.to) is None:
            raise HTTPException(status_code=404, detail=f"nobody named {note.to!r} has joined")
        try:
            with closing(connect()) as conn, conn:
                cursor = conn.execute(
                    "INSERT INTO notes (sender, recipient, kind, body, ts, agent, re, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (note.sender, note.to, note.kind, note.body, note.ts, note.agent, note.re, note.sig),
                )
        except sqlite3.IntegrityError as err:
            raise HTTPException(status_code=409, detail="this exact note was already delivered") from err
        with arrived:
            arrived.notify_all()
        note_id = cursor.lastrowid or 0
        log.info("note queued", extra={"note_id": note_id, "sender": note.sender, "recipient": note.to, "kind": note.kind})
        return Receipt(id=note_id)

    @app.get("/channels", dependencies=[Depends(caller)])
    def channels() -> list[ChannelInfo]:
        with closing(connect()) as conn:
            names: list[tuple[str]] = conn.execute("SELECT DISTINCT channel FROM members ORDER BY channel").fetchall()
        return [channel_info(channel) for (channel,) in names]

    @app.post("/channels/{name}/join")
    def join_channel(name: Name, me: Annotated[str, Depends(caller)]) -> ChannelInfo:
        """Join a channel, creating it if nobody is in it yet."""
        with closing(connect()) as conn, conn:
            conn.execute("INSERT OR IGNORE INTO members (channel, user) VALUES (?, ?)", (f"#{name}", me))
        log.info("channel joined", extra={"channel": f"#{name}", "user": me})
        return channel_info(f"#{name}")

    @app.post("/channels/{name}/leave")
    def leave_channel(name: Name, me: Annotated[str, Depends(caller)]) -> ChannelInfo:
        with closing(connect()) as conn, conn:
            conn.execute("DELETE FROM members WHERE channel = ? AND user = ?", (f"#{name}", me))
        log.info("channel left", extra={"channel": f"#{name}", "user": me})
        return channel_info(f"#{name}")

    @app.put("/channels/{name}/repo")
    def pin_repo(name: Name, repo: RepoRef, me: Annotated[str, Depends(caller)]) -> ChannelInfo:
        """Say which repo a channel is about. Any member may set or change it."""
        channel = member_of(name, me)
        shareable(repo)
        with closing(connect()) as conn, conn:
            conn.execute("INSERT OR REPLACE INTO pins (channel, name, key, url) VALUES (?, ?, ?, ?)", (channel, repo.name, repo.key, repo.url))
        return channel_info(channel)

    @app.delete("/channels/{name}/repo")
    def unpin_repo(name: Name, me: Annotated[str, Depends(caller)]) -> ChannelInfo:
        channel = member_of(name, me)
        with closing(connect()) as conn, conn:
            conn.execute("DELETE FROM pins WHERE channel = ?", (channel,))
        return channel_info(channel)

    def fetch(me: str, after: int, tail: int | None, mine: bool, status: bool) -> list[Delivered]:
        visible = "(recipient = :me OR recipient IN (SELECT channel FROM members WHERE user = :me) OR sender = :me) AND (:mine OR sender != :me) AND (:status OR kind = 'note')"
        columns = "id, sender, recipient, kind, body, ts, agent, re, sig"
        if tail is None:
            query = f"SELECT {columns} FROM notes WHERE id > :after AND {visible} ORDER BY id LIMIT :limit"
        else:
            query = f"SELECT * FROM (SELECT {columns} FROM notes WHERE id > :after AND {visible} ORDER BY id DESC LIMIT :limit) ORDER BY id"
        with closing(connect()) as conn:
            rows: list[tuple[int, str, str, str, str, int, str | None, int | None, str]] = conn.execute(
                query, {"me": me, "after": after, "mine": mine, "status": status, "limit": tail or PAGE}
            ).fetchall()
        return [
            Delivered(id=note_id, note=Note.model_validate({"sender": sender, "to": to, "kind": kind, "body": body, "ts": ts, "agent": agent, "re": re, "sig": sig}))
            for note_id, sender, to, kind, body, ts, agent, re, sig in rows
        ]

    # ponytail: each waiting long-poll holds one threadpool thread (default 40). Fine for a desk row; go async if the team outgrows it.
    @app.get("/notes")
    def get_notes(
        me: Annotated[str, Depends(caller)],
        after: Annotated[int, Query(ge=0)] = 0,
        wait: Annotated[float, Query(ge=0, le=MAX_WAIT)] = 0,
        tail: Annotated[int | None, Query(ge=1, le=HISTORY)] = None,
        mine: bool = True,
        status: bool = True,
    ) -> list[Delivered]:
        """Notes the caller can see with an id above `after`, oldest first: sent to them, to a channel they are in, or (unless `mine` is false) sent by them.

        `wait` holds the request open until one arrives; `tail` returns only the newest few; `status` false leaves out agent status reports.
        """
        deadline = time.monotonic() + wait
        with arrived:  # Held across the check so a note cannot land between "nothing yet" and going to sleep.
            while True:
                notes = fetch(me, after, tail, mine, status)
                remaining = deadline - time.monotonic()
                if notes or remaining <= 0:
                    return notes
                arrived.wait(remaining)

    return app


def serve(host: str, port: int) -> None:
    import uvicorn  # Imported here so the client commands start without loading the web server.

    handler = logging.StreamHandler()
    handler.setFormatter(_KeyValueFormatter("%(levelname)s:     %(name)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    settings = HubSettings()  # pydantic-settings fills the fields from DESKMATE_* environment variables and fails if one is missing.
    uvicorn.run(create_app(settings), host=host, port=port, timeout_graceful_shutdown=3)
