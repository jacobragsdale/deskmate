"""The deskmate command: the chat interface by default, plus one-shot commands for scripts and agents."""

import argparse
import signal
import sys
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError

from deskmate.chat import chat_of
from deskmate.client import DEFAULT_AGENT, POLL_WAIT, Client, DeskmateError, Runner, Transport, default_dev, default_home, http, join, load_client, run_agent
from deskmate.wire import Delivered, is_channel


def render(delivered: Delivered, *, trusted: bool) -> str:
    note = delivered.note
    if not trusted:
        return f"!! note {delivered.id} claims to be from {note.sender}, but its signature does not match the key first seen for them. Ignored."
    when = datetime.fromtimestamp(note.ts, tz=UTC).astimezone().strftime("%a %H:%M")
    where = f" in {note.to}" if is_channel(note.to) else ""
    lines = "\n".join(f"│ {line}" for line in note.body.splitlines())
    return f"┌ {delivered.id} · {note.sender}{f' ({note.agent} agent)' if note.agent else ''}{where} · {when}\n{lines}\n└"


def _await_reply(client: Client, chat: str, after: int, seconds: float) -> Delivered | None:
    """The next trusted note from someone else in this chat, if one arrives in time."""
    deadline = time.monotonic() + seconds
    while (remaining := deadline - time.monotonic()) > 0:
        for delivered in client.notes(after=after, wait=min(remaining, POLL_WAIT), mine=False, status=False):
            after = delivered.id
            if chat_of(delivered.note, client.config.name) == chat and client.is_trusted(delivered.note):
                return delivered
    return None


def _explain(err: DeskmateError | ValidationError) -> str:
    if isinstance(err, ValidationError):
        first = err.errors()[0]
        return f"invalid {'.'.join(str(part) for part in first['loc']) or 'input'}: {first['msg']}"
    return str(err)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deskmate", description="Chat with your teammates and their coding agents. With no command, opens the chat interface. Your agents are your checkouts under ~/dev."
    )
    commands = parser.add_subparsers(dest="command")
    join_cmd = commands.add_parser("join", help="register your name and a new key with a hub")
    join_cmd.add_argument("hub")
    join_cmd.add_argument("name")
    join_cmd.add_argument("token")
    join_cmd.add_argument("--agent", default=DEFAULT_AGENT, help="command that answers notes; the prompt is appended as its last argument (default: %(default)s)")
    send_cmd = commands.add_parser("send", help="send a note to a teammate or a channel", epilog="Quote a channel so the shell does not treat it as a comment: deskmate send '#backend' hello")
    send_cmd.add_argument("to", help="a name, or a channel such as '#backend'")
    send_cmd.add_argument("text", nargs="+", help="the note, or - to read it from stdin")
    send_cmd.add_argument("--wait", type=float, default=0, metavar="SECONDS", help="wait this long for the next note in that chat and print it")
    inbox_cmd = commands.add_parser("inbox", help="print notes other people sent you or your channels (the newest 20 unless --after is given)")
    inbox_cmd.add_argument("--after", type=int, metavar="ID", help="only notes newer than this id")
    inbox_cmd.add_argument("--wait", type=float, default=0, metavar="SECONDS", help="with --after: wait this long for a new note")
    commands.add_parser("who", help="list everyone who has joined")
    commands.add_parser("repos", help="list which team repos each person has checked out, and on which branch")
    channel_cmd = commands.add_parser("channel", help="list channels, or join or leave one")
    channel_cmd.add_argument("action", nargs="?", choices=["list", "join", "leave"], default="list")
    channel_cmd.add_argument("name", nargs="?", help="the channel to join or leave; joining a new name creates it")
    hub_cmd = commands.add_parser("hub", help="run the hub (needs DESKMATE_JOIN_TOKEN and DESKMATE_DB)")
    hub_cmd.add_argument("--host", default="127.0.0.1")
    hub_cmd.add_argument("--port", type=int, default=8787)
    return parser


def _channel(client: Client, action: str, name: str | None) -> None:
    if action == "list":
        me = client.config.name
        print("\n".join(f"{channel.name}{' (joined)' if me in channel.members else ''}  {', '.join(channel.members)}" for channel in client.channels()) or "no channels yet")
        return
    if name is None:
        msg = f"which channel? Try: deskmate channel {action} backend"
        raise DeskmateError(msg)
    info = client.join_channel(name) if action == "join" else client.leave_channel(name)
    print(f"{'joined' if action == 'join' else 'left'} {info.name}; members: {', '.join(info.members) or 'none'}")


def _send(client: Client, to: str, words: list[str], seconds: float) -> None:
    sent = client.send(to, sys.stdin.read().strip() if words == ["-"] else " ".join(words))
    print(f"→ sent {sent} to {to}")
    if seconds > 0:
        reply = _await_reply(client, to, sent, seconds)
        print(render(reply, trusted=True) if reply else f"nothing new in {to} yet; check later with: deskmate inbox --after {sent}")


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
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            msg = "the chat interface needs a terminal; from a script use `deskmate send` and `deskmate inbox`"
            raise DeskmateError(msg)
        from deskmate.tui import DeskmateApp  # Imported here so one-shot commands start without loading the interface.

        app = DeskmateApp(client, default_dev(), run)

        def terminal_gone(signum: int, _frame: object) -> None:
            app.stop_agents()  # A closed window or a kill must not leave an agent working with nobody to read its answer.
            raise SystemExit(128 + signum)

        signal.signal(signal.SIGHUP, terminal_gone)
        signal.signal(signal.SIGTERM, terminal_gone)
        app.run()
    elif command == "who":
        print("\n".join(user.name + (" (you)" if user.name == client.config.name else "") for user in client.users()))
    elif command == "repos":
        print("\n".join(f"@{repo.user}/{repo.name}  {repo.branch}" for repo in client.repos()) or "nobody has shared a repo yet; repos under ~/dev are shared once the chat interface has run")
    elif command == "channel":
        action: str = args.action
        channel: str | None = args.name
        _channel(client, action, channel)
    elif command == "inbox":
        after: int | None = args.after
        wait: float = args.wait
        notes = client.notes(tail=20, mine=False, status=False) if after is None else client.notes(after=after, wait=wait, mine=False, status=False)
        print("\n".join(render(delivered, trusted=client.is_trusted(delivered.note)) for delivered in notes) or "no notes")
    else:
        to: str = args.to
        words: list[str] = args.text
        seconds: float = args.wait
        _send(client, to, words, seconds)
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
