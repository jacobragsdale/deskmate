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

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from pydantic import StringConstraints
from pydantic_settings import BaseSettings, SettingsConfigDict

from deskmate.wire import ChannelInfo, Delivered, Join, Name, Note, Receipt, User, auth_claim, auth_is_valid, is_channel, is_fresh, note_is_authentic

log = logging.getLogger(__name__)

MAX_WAIT = 30.0  # Longest a client may hold one long-poll open, in seconds.
PAGE = 100
HISTORY = 500  # Most notes one `tail` request may ask for.

SCHEMA = """
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, pubkey TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (channel TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY (channel, user));
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    body TEXT NOT NULL,
    ts INTEGER NOT NULL,
    agent INTEGER NOT NULL,
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
echo "Run 'deskmate' inside the repo you want your agent to answer from."
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


def create_app(settings: HubSettings, now: Callable[[], float] = time.time) -> FastAPI:  # noqa: C901 -- one closure holds the routes; each route is simple on its own
    arrived = threading.Condition()

    def connect() -> sqlite3.Connection:
        return sqlite3.connect(settings.db, timeout=5)

    def pubkey_of(name: str) -> str | None:
        with closing(connect()) as conn:
            row: tuple[str] | None = conn.execute("SELECT pubkey FROM users WHERE name = ?", (name,)).fetchone()
        return row[0] if row else None

    def members_of(channel: str) -> tuple[str, ...]:
        with closing(connect()) as conn:
            rows: list[tuple[str]] = conn.execute("SELECT user FROM members WHERE channel = ? ORDER BY user", (channel,)).fetchall()
        return tuple(user for (user,) in rows)

    def init_db() -> None:
        with closing(connect()) as conn:
            conn.executescript(SCHEMA)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        await asyncio.to_thread(init_db)
        log.info("hub ready", extra={"db": str(settings.db)})
        yield

    app = FastAPI(title="deskmate hub", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def caller(authorization: Annotated[str, Header()] = "") -> str:
        claim = auth_claim(authorization)
        pubkey = pubkey_of(claim[0]) if claim else None
        if claim is None or pubkey is None or not auth_is_valid(*claim, pubkey=pubkey, now=now()):
            raise HTTPException(status_code=401, detail="not signed by a known user, or your clock is more than 5 minutes off")
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

    @app.get("/users", dependencies=[Depends(caller)])
    def users() -> list[User]:
        with closing(connect()) as conn:
            rows: list[tuple[str, str]] = conn.execute("SELECT name, pubkey FROM users ORDER BY name").fetchall()
        return [User(name=name, pubkey=pubkey) for name, pubkey in rows]

    @app.post("/notes", status_code=201)
    def post_note(note: Note) -> Receipt:
        pubkey = pubkey_of(note.sender)
        if pubkey is None or not note_is_authentic(note, pubkey):
            raise HTTPException(status_code=401, detail="note is not signed by its sender")
        if not is_fresh(note.ts, now()):
            raise HTTPException(status_code=400, detail="note timestamp is more than 5 minutes off the hub clock; check your system time")
        if is_channel(note.to):
            if note.sender not in members_of(note.to):
                raise HTTPException(status_code=403, detail=f"join {note.to} before posting to it")
        elif pubkey_of(note.to) is None:
            raise HTTPException(status_code=404, detail=f"nobody named {note.to!r} has joined")
        try:
            with closing(connect()) as conn, conn:
                cursor = conn.execute(
                    "INSERT INTO notes (sender, recipient, body, ts, agent, re, sig) VALUES (?, ?, ?, ?, ?, ?, ?)", (note.sender, note.to, note.body, note.ts, note.agent, note.re, note.sig)
                )
        except sqlite3.IntegrityError as err:
            raise HTTPException(status_code=409, detail="this exact note was already delivered") from err
        with arrived:
            arrived.notify_all()
        note_id = cursor.lastrowid or 0
        log.info("note queued", extra={"note_id": note_id, "sender": note.sender, "recipient": note.to})
        return Receipt(id=note_id)

    @app.get("/channels", dependencies=[Depends(caller)])
    def channels() -> list[ChannelInfo]:
        with closing(connect()) as conn:
            rows: list[tuple[str, str]] = conn.execute("SELECT channel, user FROM members ORDER BY channel, user").fetchall()
        grouped: dict[str, list[str]] = {}
        for channel, user in rows:
            grouped.setdefault(channel, []).append(user)
        return [ChannelInfo(name=channel, members=tuple(members)) for channel, members in grouped.items()]

    @app.post("/channels/{name}/join")
    def join_channel(name: Name, me: Annotated[str, Depends(caller)]) -> ChannelInfo:
        """Join a channel, creating it if nobody is in it yet."""
        with closing(connect()) as conn, conn:
            conn.execute("INSERT OR IGNORE INTO members (channel, user) VALUES (?, ?)", (f"#{name}", me))
        log.info("channel joined", extra={"channel": f"#{name}", "user": me})
        return ChannelInfo(name=f"#{name}", members=members_of(f"#{name}"))

    @app.post("/channels/{name}/leave")
    def leave_channel(name: Name, me: Annotated[str, Depends(caller)]) -> ChannelInfo:
        with closing(connect()) as conn, conn:
            conn.execute("DELETE FROM members WHERE channel = ? AND user = ?", (f"#{name}", me))
        log.info("channel left", extra={"channel": f"#{name}", "user": me})
        return ChannelInfo(name=f"#{name}", members=members_of(f"#{name}"))

    def fetch(me: str, after: int, tail: int | None, mine: bool) -> list[Delivered]:
        visible = "(recipient = :me OR recipient IN (SELECT channel FROM members WHERE user = :me) OR sender = :me) AND (:mine OR sender != :me)"
        columns = "id, sender, recipient, body, ts, agent, re, sig"
        if tail is None:
            query = f"SELECT {columns} FROM notes WHERE id > :after AND {visible} ORDER BY id LIMIT :limit"
        else:
            query = f"SELECT * FROM (SELECT {columns} FROM notes WHERE id > :after AND {visible} ORDER BY id DESC LIMIT :limit) ORDER BY id"
        with closing(connect()) as conn:
            rows: list[tuple[int, str, str, str, int, int, int | None, str]] = conn.execute(query, {"me": me, "after": after, "mine": mine, "limit": tail or PAGE}).fetchall()
        return [Delivered(id=note_id, note=Note(sender=sender, to=to, body=body, ts=ts, agent=bool(agent), re=re, sig=sig)) for note_id, sender, to, body, ts, agent, re, sig in rows]

    # ponytail: each waiting long-poll holds one threadpool thread (default 40). Fine for a desk row; go async if the team outgrows it.
    @app.get("/notes")
    def get_notes(
        me: Annotated[str, Depends(caller)],
        after: Annotated[int, Query(ge=0)] = 0,
        wait: Annotated[float, Query(ge=0, le=MAX_WAIT)] = 0,
        tail: Annotated[int | None, Query(ge=1, le=HISTORY)] = None,
        mine: bool = True,
    ) -> list[Delivered]:
        """Notes the caller can see with an id above `after`, oldest first: sent to them, to a channel they are in, or (unless `mine` is false) sent by them.

        `wait` holds the request open until one arrives; `tail` returns only the newest few.
        """
        deadline = time.monotonic() + wait
        with arrived:  # Held across the check so a note cannot land between "nothing yet" and going to sleep.
            while True:
                notes = fetch(me, after, tail, mine)
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
