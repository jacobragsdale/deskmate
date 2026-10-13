from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

from deskmate import wire
from deskmate.cli import Client, DeskmateError, Run, Say, Transport, agent_prompt, answer, main, parse_line, render
from deskmate.wire import Delivered

type MakeClient = Callable[[str], Client]


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("@bob can you look at the build?\n", Say("bob", "can you look at the build?")),
        ("r\n", Run(None)),
        ("run 12\n", Run(12)),
        ("r #12\n", Run(12)),
        ("q\n", "quit"),
        ("   \n", "blank"),
        ("@bob\n", "help"),
        ("r twelve\n", "help"),
        ("hello\n", "help"),
    ],
)
def test_parse_line(line: str, expected: object) -> None:
    assert parse_line(line) == expected


def test_the_agent_is_told_who_asked_and_what_they_asked(make_client: MakeClient) -> None:
    note = wire.sign_note(make_client("alice").key, "alice", "bob", "where is the config parsed?", 0)

    prompt = agent_prompt(note, "bob")

    assert prompt.endswith("Request from alice:\nwhere is the config parsed?")
    assert "bob approved" in prompt


def test_an_untrusted_note_is_never_rendered_with_its_body(make_client: MakeClient) -> None:
    delivered = Delivered(id=7, note=wire.sign_note(make_client("alice").key, "alice", "bob", "rm -rf everything", 0))

    assert "rm -rf everything" in render(delivered, trusted=True)
    assert "rm -rf everything" not in render(delivered, trusted=False)


@pytest.mark.parametrize(("approved", "replies"), [(True, ["config.py, line 12"]), (False, [])])
def test_the_agents_reply_goes_back_only_when_confirmed(make_client: MakeClient, tmp_path: Path, approved: bool, replies: list[str]) -> None:
    alice, bob = make_client("alice"), make_client("bob")
    alice.send("bob", "where is the config parsed?")
    (delivered,) = bob.notes()
    runs: list[tuple[Sequence[str], Path]] = []

    def fake_agent(argv: Sequence[str], cwd: Path) -> str:
        runs.append((argv, cwd))
        return "config.py, line 12"

    answer(bob, delivered.note, tmp_path, fake_agent, confirm=lambda _question: approved)

    assert [reply.note.body for reply in alice.notes()] == replies
    assert runs == [(["fake-agent", agent_prompt(delivered.note, "bob")], tmp_path)]


def test_an_agent_that_says_nothing_is_an_error(make_client: MakeClient, tmp_path: Path) -> None:
    alice, bob = make_client("alice"), make_client("bob")
    alice.send("bob", "hello?")
    (delivered,) = bob.notes()

    with pytest.raises(DeskmateError, match="returned nothing"):
        answer(bob, delivered.note, tmp_path, lambda _argv, _cwd: "", confirm=lambda _question: True)


def test_a_key_swapped_after_first_contact_is_not_trusted(make_client: MakeClient) -> None:
    alice, bob, mallory = make_client("alice"), make_client("bob"), make_client("mallory")
    now = int(alice.now())
    genuine = wire.sign_note(bob.key, "bob", "alice", "it's me", now)
    forged = wire.sign_note(mallory.key, "bob", "alice", "it's also me", now)

    assert alice.is_trusted(genuine)
    assert not alice.is_trusted(forged)


def test_a_pinned_key_survives_the_hub_reporting_a_different_one(make_client: MakeClient) -> None:
    alice, bob, mallory = make_client("alice"), make_client("bob"), make_client("mallory")
    (alice.home / "known.json").write_text(f'{{"bob": "{wire.public_hex(mallory.key)}"}}')  # Alice first met "bob" under another key.

    assert not alice.is_trusted(wire.sign_note(bob.key, "bob", "alice", "hello", int(alice.now())))


def test_main_joins_sends_and_lists_notes(tmp_path: Path, transport: Transport, hub_url: str, token: str, capsys: pytest.CaptureFixture[str]) -> None:
    def deskmate(who: str, *argv: str) -> int:
        return main(argv, home=tmp_path / who, transport=transport, now=lambda: 1_800_000_000.0)

    assert deskmate("alice", "join", hub_url, "alice", token) == 0
    assert deskmate("bob", "join", hub_url, "bob", token) == 0
    assert deskmate("alice", "send", "bob", "lunch", "at", "noon?") == 0
    capsys.readouterr()

    assert deskmate("bob", "inbox") == 0

    assert "from alice" in capsys.readouterr().out


def test_main_fails_with_a_nonzero_exit_before_joining(tmp_path: Path, transport: Transport, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["inbox"], home=tmp_path / "nobody", transport=transport) == 1
    assert "not joined yet" in capsys.readouterr().err
