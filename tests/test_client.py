import sys
import threading
from collections.abc import Callable
from pathlib import Path

import pytest

from deskmate import wire
from deskmate.client import AgentCancelledError, Client, DeskmateError, run_agent

type MakeClient = Callable[[str], Client]


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


def test_run_agent_returns_what_the_command_printed(tmp_path: Path) -> None:
    assert run_agent([sys.executable, "-c", "import os, sys; print(sys.argv[1], os.getcwd())", "the prompt"], tmp_path, threading.Event()) == f"the prompt {tmp_path}"


def test_run_agent_stops_the_command_when_cancelled(tmp_path: Path) -> None:
    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()

    with pytest.raises(AgentCancelledError):
        run_agent([sys.executable, "-c", "import time; time.sleep(60)"], tmp_path, cancel)


@pytest.mark.parametrize(("argv", "problem"), [([sys.executable, "-c", "import sys; sys.exit('boom')"], "exited with status 1: boom"), (["deskmate-no-such-agent"], "agent command not found")])
def test_run_agent_reports_a_command_that_fails(tmp_path: Path, argv: list[str], problem: str) -> None:
    with pytest.raises(DeskmateError, match=problem):
        run_agent(argv, tmp_path, threading.Event())
