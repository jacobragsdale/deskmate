"""The deskmate client: join a hub, pass notes, and approve agent runs for the notes you receive."""

import argparse
import json
import os
import queue
import select
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import StringConstraints, TypeAdapter, ValidationError

from deskmate import wire
from deskmate.wire import Delivered, Join, Model, Name, Note, Receipt, User

DEFAULT_AGENT = "claude -p"
AGENT_TIMEOUT = 900  # Seconds an approved agent run may take.
POLL_WAIT = 25.0  # Seconds one long-poll stays open; under the hub's limit and common proxy timeouts.
RETRY_DELAY = 5.0
JSON = {"Content-Type": "application/json"}
HELP = "  @name <text>  pass a note        r [id]  run your agent on a note (newest if no id)        q  quit"

type Transport = Callable[[str, str, Mapping[str, str], bytes | None, float], bytes]
type Runner = Callable[[Sequence[str], Path], str]

_USERS = TypeAdapter(list[User])
_DELIVERED = TypeAdapter(list[Delivered])
_PINS = TypeAdapter(dict[str, str])


class DeskmateError(Exception):
    """A failure the user can act on; shown without a traceback."""


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

    def _get(self, path: str, timeout: float = 10) -> bytes:
        headers = {"Authorization": wire.auth_header(self.key, self.config.name, int(self.now()))}
        return self.transport("GET", self.config.hub + path, headers, None, timeout)

    def users(self) -> list[User]:
        return _USERS.validate_json(self._get("/users"))

    def send(self, to: str, body: str) -> int:
        note = wire.sign_note(self.key, self.config.name, to, body, int(self.now()))
        raw = self.transport("POST", self.config.hub + "/notes", JSON, note.model_dump_json().encode(), 10)
        return Receipt.model_validate_json(raw).id

    def notes(self, *, after: int = 0, wait: float = 0, tail: int | None = None) -> list[Delivered]:
        query = f"/notes?after={after}&wait={wait:.1f}" + (f"&tail={tail}" if tail else "")
        return _DELIVERED.validate_json(self._get(query, timeout=wait + 10))

    def is_trusted(self, note: Note) -> bool:
        """Check a note against the key first seen for its sender, so a hub that later swaps a key cannot forge notes."""
        pin_file = self.home / "known.json"
        pins = _PINS.validate_json(pin_file.read_bytes()) if pin_file.exists() else {}
        if note.sender not in pins:
            pins = {user.name: user.pubkey for user in self.users()} | pins  # Keys already pinned win over what the hub says now.
            pin_file.write_text(json.dumps(pins, indent=1, sort_keys=True))
        pubkey = pins.get(note.sender)
        return pubkey is not None and wire.note_is_authentic(note, pubkey)


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


def run_agent(argv: Sequence[str], cwd: Path) -> str:
    try:
        done = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=AGENT_TIMEOUT, check=False)
    except FileNotFoundError as err:
        msg = f'agent command not found: {argv[0]!r}. Set "agent" in {default_home() / "config.json"}'
        raise DeskmateError(msg) from err
    except subprocess.TimeoutExpired as err:
        msg = f"the agent did not finish within {AGENT_TIMEOUT} seconds"
        raise DeskmateError(msg) from err
    if done.returncode != 0:
        msg = f"the agent exited with status {done.returncode}: {(done.stderr or done.stdout).strip()[-500:]}"
        raise DeskmateError(msg)
    return done.stdout.strip()


def agent_prompt(note: Note, me: str) -> str:
    return (
        f"{note.sender}, a teammate of {me}, sent the request below through deskmate. "
        f"{me} approved running you on it and will read your reply before it goes back to {note.sender}.\n"
        "Answer the request directly and concisely, working from the current directory. "
        "Never put secrets, tokens or credentials in the reply.\n\n"
        f"Request from {note.sender}:\n{note.body}"
    )


def answer(client: Client, note: Note, cwd: Path, run: Runner, confirm: Callable[[str], bool]) -> int | None:
    """Run the local agent on a note and send its reply once the user confirms. Returns the reply's id, or None when it was not sent."""
    reply = run([*shlex.split(client.config.agent), agent_prompt(note, client.config.name)], cwd)[: wire.MAX_BODY]
    if not reply:
        msg = "the agent returned nothing"
        raise DeskmateError(msg)
    print(reply)
    if not confirm(f"send this to {note.sender}? [Y/n] "):
        return None
    return client.send(note.sender, reply)


@dataclass(frozen=True)
class Say:
    to: str
    body: str


@dataclass(frozen=True)
class Run:
    note_id: int | None  # None: the newest note.


def parse_line(line: str) -> Say | Run | Literal["quit", "blank", "help"]:
    text = line.strip()
    if not text:
        return "blank"
    if text in {"q", "quit", "exit"}:
        return "quit"
    head, _, rest = text.partition(" ")
    rest = rest.strip()
    if head.startswith("@") and len(head) > 1 and rest:
        return Say(head[1:], rest)
    if head in {"r", "run"} and not rest:
        return Run(None)
    if head in {"r", "run"} and rest.removeprefix("#").isdecimal():
        return Run(int(rest.removeprefix("#")))
    return "help"


def render(delivered: Delivered, *, trusted: bool) -> str:
    note = delivered.note
    if not trusted:
        return f"!! #{delivered.id} claims to be from {note.sender}, but its signature does not match the key first seen for them. Ignored."
    when = datetime.fromtimestamp(note.ts, tz=UTC).astimezone().strftime("%a %H:%M")
    lines = "\n".join(f"│ {line}" for line in note.body.splitlines())
    return f"┌ #{delivered.id} from {note.sender} · {when}\n{lines}\n└"


def _poll(client: Client, after: int, arrivals: "queue.SimpleQueue[tuple[Delivered, bool] | str]") -> None:
    failing = False
    while True:
        try:
            batch = [(delivered, client.is_trusted(delivered.note)) for delivered in client.notes(after=after, wait=POLL_WAIT)]
        except (DeskmateError, ValidationError) as err:
            if not failing:
                arrivals.put(f"!! {err} (retrying)")
            failing = True
            time.sleep(RETRY_DELAY)
            continue
        if failing:
            arrivals.put("reconnected")
        failing = False
        for item in batch:
            arrivals.put(item)
            after = item[0].id


def _confirm(question: str) -> bool:
    return input(question).strip().lower() in {"", "y", "yes"}


def watch(client: Client, cwd: Path, run: Runner) -> int:
    """Show notes as they arrive and act on typed lines. Notes wait here until the user decides; nothing runs on its own."""
    cursor_file = client.home / "cursor"
    arrivals: queue.SimpleQueue[tuple[Delivered, bool] | str] = queue.SimpleQueue()
    threading.Thread(target=_poll, args=(client, int(cursor_file.read_text()) if cursor_file.exists() else 0, arrivals), daemon=True).start()
    runnable: dict[int, Note] = {}
    print(f"deskmate · you are {client.config.name} on {client.config.hub} · `{client.config.agent}` runs in {cwd}\n{HELP}")
    # ponytail: a note that lands while you are typing prints over your half-typed line (the line itself survives). A TUI is the upgrade.
    while True:
        while not arrivals.empty():
            item = arrivals.get()
            if isinstance(item, str):
                print(item)
                continue
            delivered, trusted = item
            print(("\a" if sys.stdout.isatty() else "") + render(delivered, trusted=trusted))
            if trusted:
                runnable[delivered.id] = delivered.note
                print(f"  r {delivered.id} = run your agent on it · @{delivered.note.sender} <text> = answer yourself")
            cursor_file.write_text(str(delivered.id))
        if not select.select([sys.stdin], [], [], 0.25)[0]:
            continue
        line = sys.stdin.readline()
        command = parse_line(line) if line else "quit"
        try:
            match command:
                case "quit":
                    return 0
                case "help":
                    print(HELP)
                case Say(to, body):
                    print(f"→ #{client.send(to, body)} to {to}")
                case Run(note_id) if runnable:
                    note = runnable.get(next(reversed(runnable)) if note_id is None else note_id)
                    if note is None:
                        print(f"no note #{note_id} in this session; `deskmate inbox` lists older ones")
                        continue
                    print(f"running `{client.config.agent}` on the note from {note.sender} (ctrl-c cancels) …")
                    sent = answer(client, note, cwd, run, _confirm)
                    print(f"→ #{sent} to {note.sender}" if sent is not None else "not sent")
                case Run():
                    print("no notes to run yet")
                case _:
                    pass
        except (DeskmateError, ValidationError) as err:
            print(f"!! {_explain(err)}")
        except KeyboardInterrupt:
            print("\ncancelled")


def _await_reply(client: Client, sender: str, after: int, seconds: float) -> Delivered | None:
    deadline = time.monotonic() + seconds
    while (remaining := deadline - time.monotonic()) > 0:
        for delivered in client.notes(after=after, wait=min(remaining, POLL_WAIT)):
            after = delivered.id
            if delivered.note.sender == sender and client.is_trusted(delivered.note):
                return delivered
    return None


def _explain(err: DeskmateError | ValidationError) -> str:
    if isinstance(err, ValidationError):
        first = err.errors()[0]
        return f"invalid {'.'.join(str(part) for part in first['loc']) or 'input'}: {first['msg']}"
    return str(err)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deskmate", description="Pass notes to your teammates' coding agents. With no command: watch for notes and approve agent runs in the current directory.")
    commands = parser.add_subparsers(dest="command")
    join_cmd = commands.add_parser("join", help="register your name and a new key with a hub")
    join_cmd.add_argument("hub")
    join_cmd.add_argument("name")
    join_cmd.add_argument("token")
    join_cmd.add_argument("--agent", default=DEFAULT_AGENT, help="command that answers notes; the prompt is appended as its last argument (default: %(default)s)")
    send_cmd = commands.add_parser("send", help="pass a note to a teammate")
    send_cmd.add_argument("to")
    send_cmd.add_argument("text", nargs="+", help="the note, or - to read it from stdin")
    send_cmd.add_argument("--wait", type=float, default=0, metavar="SECONDS", help="wait this long for their reply and print it")
    inbox_cmd = commands.add_parser("inbox", help="print notes sent to you (the newest 20 unless --after is given)")
    inbox_cmd.add_argument("--after", type=int, metavar="ID", help="only notes newer than this id")
    inbox_cmd.add_argument("--wait", type=float, default=0, metavar="SECONDS", help="with --after: wait this long for a new note")
    commands.add_parser("who", help="list everyone who has joined")
    hub_cmd = commands.add_parser("hub", help="run the hub (needs DESKMATE_JOIN_TOKEN and DESKMATE_DB)")
    hub_cmd.add_argument("--host", default="127.0.0.1")
    hub_cmd.add_argument("--port", type=int, default=8787)
    return parser


def _run(args: argparse.Namespace, home: Path, transport: Transport, run: Runner, now: Callable[[], float]) -> int:
    command: str | None = args.command
    if command == "hub":
        from deskmate.hub import serve  # Imported here so the client commands start without loading the web server.

        host: str = args.host
        port: int = args.port
        serve(host, port)
        return 0
    if command == "join":
        hub, name, token, agent = str(args.hub), str(args.name), str(args.token), str(args.agent)
        config = join(home, hub, name, token, agent, transport)
        print(f"joined {config.hub} as {config.name}; your agent command is `{config.agent}`")
        return 0
    client = load_client(home, transport, now)
    if command is None:
        return watch(client, Path.cwd(), run)
    if command == "who":
        print("\n".join(user.name + (" (you)" if user.name == client.config.name else "") for user in client.users()))
    elif command == "inbox":
        after: int | None = args.after
        wait: float = args.wait
        notes = client.notes(tail=20) if after is None else client.notes(after=after, wait=wait)
        print("\n".join(render(delivered, trusted=client.is_trusted(delivered.note)) for delivered in notes) or "no notes")
    else:
        to: str = args.to
        words: list[str] = args.text
        seconds: float = args.wait
        sent = client.send(to, sys.stdin.read().strip() if words == ["-"] else " ".join(words))
        print(f"→ #{sent} to {to}")
        if seconds > 0:
            reply = _await_reply(client, to, sent, seconds)
            print(render(reply, trusted=True) if reply else f"no reply from {to} yet; check later with: deskmate inbox --after {sent}")
    return 0


def main(argv: Sequence[str] | None = None, *, home: Path | None = None, transport: Transport = http, run: Runner = run_agent, now: Callable[[], float] = time.time) -> int:
    args = _parser().parse_args(argv)
    try:
        return _run(args, home or default_home(), transport, run, now)
    except (DeskmateError, ValidationError) as err:
        print(f"deskmate: {_explain(err)}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
