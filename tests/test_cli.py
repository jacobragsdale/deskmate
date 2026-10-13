from collections.abc import Callable
from pathlib import Path

import pytest

from deskmate import wire
from deskmate.cli import main, render
from deskmate.client import Client, Transport
from deskmate.wire import Delivered, Repo

type MakeClient = Callable[[str], Client]
type Deskmate = Callable[..., int]


@pytest.fixture
def deskmate(tmp_path: Path, transport: Transport) -> Deskmate:
    """Run the command as a named person, each with their own home directory."""

    def run(who: str, *argv: str) -> int:
        return main(argv, home=tmp_path / who, transport=transport, now=lambda: 1_800_000_000.0)

    return run


def test_an_untrusted_note_is_never_rendered_with_its_body(make_client: MakeClient) -> None:
    delivered = Delivered(id=7, note=wire.sign_note(make_client("alice").key, "alice", "bob", "rm -rf everything", 0))

    assert "rm -rf everything" in render(delivered, trusted=True)
    assert "rm -rf everything" not in render(delivered, trusted=False)


def test_main_joins_sends_and_lists_notes(deskmate: Deskmate, hub_url: str, token: str, capsys: pytest.CaptureFixture[str]) -> None:
    assert deskmate("alice", "join", hub_url, "alice", token) == 0
    assert deskmate("bob", "join", hub_url, "bob", token) == 0
    assert deskmate("alice", "send", "bob", "lunch", "at", "noon?") == 0
    capsys.readouterr()

    assert deskmate("bob", "inbox") == 0

    out = capsys.readouterr().out
    assert "· alice ·" in out
    assert "│ lunch at noon?" in out


def test_main_carries_a_note_through_a_channel(deskmate: Deskmate, hub_url: str, token: str, capsys: pytest.CaptureFixture[str]) -> None:
    for who in ("alice", "bob"):
        assert deskmate(who, "join", hub_url, who, token) == 0
        assert deskmate(who, "channel", "join", "backend") == 0
    assert deskmate("alice", "send", "#backend", "deploy at noon") == 0
    capsys.readouterr()

    assert deskmate("bob", "inbox") == 0
    assert "· alice in #backend ·" in capsys.readouterr().out
    assert deskmate("alice", "inbox") == 0
    assert capsys.readouterr().out.strip() == "no notes"  # Your own notes are not in your inbox.
    assert deskmate("bob", "channel") == 0
    assert capsys.readouterr().out.strip() == "#backend (joined)  alice, bob"


def test_main_lists_shared_repos_and_keeps_status_reports_out_of_the_inbox(deskmate: Deskmate, make_client: MakeClient, capsys: pytest.CaptureFixture[str]) -> None:
    alice, bob = make_client("alice"), make_client("bob")
    alice.advertise([Repo(name="uploader", key="dev.azure.com/acme/platform/uploader", url="https://dev.azure.com/acme/Platform/_git/uploader", branch="feature/retry")])
    asked = bob.send("alice", "@alice/uploader where do we retry?")
    alice.send("bob", "working\nfeature/retry", kind="status", agent="uploader", re=asked)
    alice.send("bob", "in queue.py", agent="uploader", re=asked)

    assert deskmate("bob", "repos") == 0
    assert capsys.readouterr().out.strip() == "@alice/uploader  feature/retry"
    assert deskmate("bob", "inbox") == 0

    out = capsys.readouterr().out
    assert "· alice (uploader agent) ·" in out
    assert "working" not in out


@pytest.mark.parametrize(("argv", "problem"), [(("inbox",), "not joined yet"), (("channel", "join"), "not joined yet")])
def test_main_fails_with_a_nonzero_exit_before_joining(deskmate: Deskmate, capsys: pytest.CaptureFixture[str], argv: tuple[str, ...], problem: str) -> None:
    assert deskmate("nobody", *argv) == 1
    assert problem in capsys.readouterr().err


def test_main_refuses_to_open_the_interface_without_a_terminal(deskmate: Deskmate, hub_url: str, token: str, capsys: pytest.CaptureFixture[str]) -> None:
    assert deskmate("alice", "join", hub_url, "alice", token) == 0

    assert deskmate("alice") == 1  # Under pytest, stdin and stdout are not terminals.
    assert "needs a terminal" in capsys.readouterr().err
