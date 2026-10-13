"""Talking to the hub as one person: identity, signed requests, key pinning, and running the local agent."""

import json
import os
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import StringConstraints, TypeAdapter

from deskmate import wire
from deskmate.wire import ChannelInfo, Delivered, Join, Model, Name, Note, Receipt, User

DEFAULT_AGENT = "claude -p"
AGENT_TIMEOUT = 900  # Seconds an approved agent run may take.
POLL_WAIT = 25.0  # Seconds one long-poll stays open; under the hub's limit and common proxy timeouts.
JSON = {"Content-Type": "application/json"}

type Transport = Callable[[str, str, Mapping[str, str], bytes | None, float], bytes]
type Runner = Callable[[Sequence[str], Path, threading.Event], str]

_USERS = TypeAdapter(list[User])
_CHANNELS = TypeAdapter(list[ChannelInfo])
_DELIVERED = TypeAdapter(list[Delivered])
_PINS = TypeAdapter(dict[str, str])


class DeskmateError(Exception):
    """A failure the user can act on; shown without a traceback."""


class AgentCancelledError(DeskmateError):
    """The user stopped an agent run."""


class Config(Model):
    hub: Annotated[str, StringConstraints(pattern=r"^https?://\S*[^/\s]$")]
    name: Name
    agent: Annotated[str, StringConstraints(min_length=1)]


def http(method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float) -> bytes:
    request = urllib.request.Request(url, data=body, method=method, headers=dict(headers))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw: bytes = response.read()
    except urllib.error.HTTPError as err:
        msg = _detail(err.read()) or f"the hub answered {err.code} for {url}"
        raise DeskmateError(msg) from err
    except (urllib.error.URLError, TimeoutError) as err:
        msg = f"cannot reach the hub at {url}: {err}"
        raise DeskmateError(msg) from err
    return raw


def _detail(raw: bytes) -> str:
    try:
        payload: object = json.loads(raw)
    except ValueError:
        return ""
    detail: object = payload.get("detail") if isinstance(payload, dict) else None
    return detail if isinstance(detail, str) else ""


@dataclass(frozen=True)
class Client:
    home: Path
    config: Config
    key: Ed25519PrivateKey
    transport: Transport
    now: Callable[[], float]

    def _call(self, method: str, path: str, timeout: float = 10) -> bytes:
        headers = {"Authorization": wire.auth_header(self.key, self.config.name, int(self.now()))}
        return self.transport(method, self.config.hub + path, headers, None, timeout)

    def users(self) -> list[User]:
        return _USERS.validate_json(self._call("GET", "/users"))

    def channels(self) -> list[ChannelInfo]:
        return _CHANNELS.validate_json(self._call("GET", "/channels"))

    def join_channel(self, channel: str) -> ChannelInfo:
        """Join a channel, creating it if it does not exist. The name may be given with or without its "#"."""
        return ChannelInfo.model_validate_json(self._call("POST", f"/channels/{_bare(channel)}/join"))

    def leave_channel(self, channel: str) -> ChannelInfo:
        return ChannelInfo.model_validate_json(self._call("POST", f"/channels/{_bare(channel)}/leave"))

    def send(self, to: str, body: str, *, agent: bool = False, re: int | None = None) -> int:
        note = wire.sign_note(self.key, self.config.name, to, body, int(self.now()), agent=agent, re=re)
        raw = self.transport("POST", self.config.hub + "/notes", JSON, note.model_dump_json().encode(), 10)
        return Receipt.model_validate_json(raw).id

    def notes(self, *, after: int = 0, wait: float = 0, tail: int | None = None, mine: bool = True) -> list[Delivered]:
        """Notes this user can see: sent to them, to their channels, and (unless `mine` is false) by them."""
        query = f"/notes?after={after}&wait={wait:.1f}&mine={'true' if mine else 'false'}" + (f"&tail={tail}" if tail else "")
        return _DELIVERED.validate_json(self._call("GET", query, timeout=wait + 10))

    def is_trusted(self, note: Note) -> bool:
        """Check a note against the key first seen for its sender, so a hub that later swaps a key cannot forge notes."""
        pin_file = self.home / "known.json"
        pins = _PINS.validate_json(pin_file.read_bytes()) if pin_file.exists() else {}
        if note.sender not in pins:
            pins = {user.name: user.pubkey for user in self.users()} | pins  # Keys already pinned win over what the hub says now.
            pin_file.write_text(json.dumps(pins, indent=1, sort_keys=True))
        pubkey = pins.get(note.sender)
        return pubkey is not None and wire.note_is_authentic(note, pubkey)


def _bare(channel: str) -> str:
    name = channel.removeprefix("#")
    TypeAdapter(Name).validate_python(name)  # It becomes part of a URL path, so refuse anything but a plain name.
    return name


def default_home() -> Path:
    # Optional override so one machine can hold several identities; absence means the usual place.
    return Path(os.environ.get("DESKMATE_HOME") or Path.home() / ".config" / "deskmate")


def join(home: Path, hub: str, name: str, token: str, agent: str, transport: Transport) -> Config:
    config = Config(hub=hub.rstrip("/"), name=name, agent=agent)
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    key_file = home / "key"
    if not key_file.exists():
        key_file.touch(mode=0o600)
        key_file.write_text(wire.private_hex(wire.new_key()))
    request = Join(name=name, pubkey=wire.public_hex(wire.load_key(key_file.read_text().strip())), token=token)
    transport("POST", config.hub + "/join", JSON, request.model_dump_json().encode(), 10)
    (home / "config.json").write_text(config.model_dump_json(indent=1))
    return config


def load_client(home: Path, transport: Transport, now: Callable[[], float]) -> Client:
    try:
        config = Config.model_validate_json((home / "config.json").read_bytes())
        key = wire.load_key((home / "key").read_text().strip())
    except FileNotFoundError as err:
        msg = "not joined yet: run your hub's install one-liner, or `deskmate join <hub-url> <your-name> <join-token>`"
        raise DeskmateError(msg) from err
    return Client(home, config, key, transport, now)


def run_agent(argv: Sequence[str], cwd: Path, cancel: threading.Event) -> str:
    """Run the agent command and return what it printed. Setting `cancel` stops it and everything it started."""
    try:
        process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    except FileNotFoundError as err:
        msg = f'agent command not found: {argv[0]!r}. Set "agent" in {default_home() / "config.json"}'
        raise DeskmateError(msg) from err
    deadline = time.monotonic() + AGENT_TIMEOUT
    while True:
        try:
            out, err = process.communicate(timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            timed_out = time.monotonic() > deadline
            if not cancel.is_set() and not timed_out:
                continue
            os.killpg(process.pid, signal.SIGKILL)  # Its own session, so this takes the agent's child processes with it.
            process.communicate()
            if timed_out:
                msg = f"the agent did not finish within {AGENT_TIMEOUT} seconds"
                raise DeskmateError(msg) from None
            raise AgentCancelledError from None
    if process.returncode != 0:
        msg = f"the agent exited with status {process.returncode}: {(err or out).strip()[-500:]}"
        raise DeskmateError(msg)
    return out.strip()
