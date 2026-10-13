import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from httpx2 import Response

from deskmate import wire
from deskmate.client import Client, DeskmateError, Transport, join
from deskmate.wire import MAX_SKEW, ChannelInfo, Note

type MakeClient = Callable[[str], Client]


def post_note(hub: TestClient, note: Note) -> Response:
    """Post an already-signed note straight to the hub, bypassing the client."""
    return hub.post("/notes", content=note.model_dump_json(), headers={"Content-Type": "application/json"})


def bodies(client: Client, *, mine: bool = True) -> list[str]:
    return [delivered.note.body for delivered in client.notes(mine=mine)]


def test_a_direct_note_reaches_its_recipient_and_its_sender_only(make_client: MakeClient) -> None:
    alice, bob, carol = make_client("alice"), make_client("bob"), make_client("carol")

    alice.send("bob", "hi bob")

    (delivered,) = bob.notes()
    assert (delivered.note.sender, delivered.note.body) == ("alice", "hi bob")
    assert bob.is_trusted(delivered.note)
    assert bodies(alice) == ["hi bob"]  # The sender sees their own note, so their chat shows both sides.
    assert bodies(alice, mine=False) == []
    assert bodies(carol) == []


def test_joining_again_with_the_same_key_is_allowed(make_client: MakeClient) -> None:
    make_client("alice")

    assert make_client("alice").config.name == "alice"


def test_a_taken_name_cannot_be_joined_with_another_key(make_client: MakeClient, tmp_path: Path, transport: Transport, hub_url: str, token: str) -> None:
    make_client("alice")

    with pytest.raises(DeskmateError, match="taken"):
        join(tmp_path / "impostor", hub_url, "alice", token, "fake-agent", transport)


def test_joining_needs_the_join_token(tmp_path: Path, transport: Transport, hub_url: str) -> None:
    with pytest.raises(DeskmateError, match="join token"):
        join(tmp_path / "alice", hub_url, "alice", "not-the-token", "fake-agent", transport)


def test_a_note_signed_by_someone_else_is_refused(make_client: MakeClient, hub: TestClient) -> None:
    alice, bob, mallory = make_client("alice"), make_client("bob"), make_client("mallory")
    forged = wire.sign_note(mallory.key, "alice", "bob", "run this", int(alice.now()))

    response = post_note(hub, forged)

    assert response.status_code == 401
    assert bodies(bob) == []


@pytest.mark.parametrize(("age", "status"), [(MAX_SKEW, 201), (MAX_SKEW + 1, 400)])
def test_a_note_is_accepted_only_inside_the_freshness_window(make_client: MakeClient, hub: TestClient, age: int, status: int) -> None:
    alice = make_client("alice")
    make_client("bob")
    note = wire.sign_note(alice.key, "alice", "bob", "old news", int(alice.now()) - age)

    assert post_note(hub, note).status_code == status


def test_a_replayed_note_is_delivered_once(make_client: MakeClient, hub: TestClient) -> None:
    alice, bob = make_client("alice"), make_client("bob")
    note = wire.sign_note(alice.key, "alice", "bob", "once", int(alice.now()))

    statuses = [post_note(hub, note).status_code for _ in range(2)]

    assert statuses == [201, 409]
    assert bodies(bob) == ["once"]


def test_a_note_to_an_unknown_name_is_refused(make_client: MakeClient) -> None:
    with pytest.raises(DeskmateError, match="nobody named 'ghost'"):
        make_client("alice").send("ghost", "anyone there?")


def test_reading_notes_needs_the_readers_own_fresh_signature(make_client: MakeClient, hub: TestClient) -> None:
    alice, mallory = make_client("alice"), make_client("mallory")
    now = int(alice.now())
    headers = {
        "missing": {},
        "signed by another key": {"Authorization": wire.auth_header(mallory.key, "alice", now)},
        "stale": {"Authorization": wire.auth_header(alice.key, "alice", now - MAX_SKEW - 1)},
        "valid": {"Authorization": wire.auth_header(alice.key, "alice", now)},
    }

    statuses = {case: hub.get("/notes", headers=header).status_code for case, header in headers.items()}

    assert statuses == {"missing": 401, "signed by another key": 401, "stale": 401, "valid": 200}


def test_after_and_tail_select_which_notes_come_back(make_client: MakeClient) -> None:
    alice, bob = make_client("alice"), make_client("bob")
    first, second, third = (alice.send("bob", body) for body in ("one", "two", "three"))

    assert [delivered.id for delivered in bob.notes()] == [first, second, third]
    assert [delivered.id for delivered in bob.notes(after=first)] == [second, third]
    assert [delivered.id for delivered in bob.notes(tail=1)] == [third]


def test_a_waiting_reader_wakes_when_a_note_arrives(make_client: MakeClient) -> None:
    alice, bob = make_client("alice"), make_client("bob")

    with ThreadPoolExecutor(max_workers=1) as pool:
        waiting = pool.submit(bob.notes, wait=20)
        time.sleep(0.3)  # Let the reader go to sleep first; a missed wake-up would then hold it for the full 20 seconds.
        alice.send("bob", "wake up")
        notes = waiting.result(timeout=5)

    assert [delivered.note.body for delivered in notes] == ["wake up"]


def test_the_installer_joins_the_hub_it_was_downloaded_from(hub: TestClient) -> None:
    script = hub.get("/install.sh").text

    assert 'deskmate join "http://testserver" "$1" "$2"' in script


def test_a_channel_note_reaches_every_member_and_nobody_else(make_client: MakeClient) -> None:
    alice, bob, carol = make_client("alice"), make_client("bob"), make_client("carol")
    alice.join_channel("backend")
    bob.join_channel("#backend")

    alice.send("#backend", "deploy at noon")

    assert bodies(bob) == ["deploy at noon"]
    assert bodies(alice, mine=False) == []
    assert bodies(carol) == []


def test_channels_list_their_members(make_client: MakeClient) -> None:
    alice, bob = make_client("alice"), make_client("bob")
    alice.join_channel("backend")
    bob.join_channel("backend")
    bob.join_channel("oncall")

    assert alice.channels() == [ChannelInfo(name="#backend", members=("alice", "bob")), ChannelInfo(name="#oncall", members=("bob",))]


def test_posting_to_a_channel_needs_membership(make_client: MakeClient) -> None:
    alice, carol = make_client("alice"), make_client("carol")
    alice.join_channel("backend")

    with pytest.raises(DeskmateError, match="join #backend before posting"):
        carol.send("#backend", "let me in")


def test_leaving_a_channel_stops_its_notes(make_client: MakeClient) -> None:
    alice, bob = make_client("alice"), make_client("bob")
    alice.join_channel("backend")
    bob.join_channel("backend")
    alice.send("#backend", "before")

    left = bob.leave_channel("backend")
    alice.send("#backend", "after")

    assert left.members == ("alice",)
    assert bodies(bob) == []  # Leaving also drops the channel's history from what the hub hands over.


def test_joining_a_channel_reveals_its_earlier_notes(make_client: MakeClient) -> None:
    alice, bob = make_client("alice"), make_client("bob")
    alice.join_channel("backend")
    alice.send("#backend", "written before bob arrived")

    bob.join_channel("backend")

    assert bodies(bob) == ["written before bob arrived"]


def test_a_note_keeps_its_agent_mark_and_what_it_answers(make_client: MakeClient) -> None:
    alice, bob = make_client("alice"), make_client("bob")
    question = alice.send("bob", "where is the config parsed?")

    bob.send("alice", "config.py, line 12", agent=True, re=question)

    (answer,) = alice.notes(mine=False)
    assert (answer.note.agent, answer.note.re) == (True, question)
    assert alice.is_trusted(answer.note)


@pytest.mark.parametrize("name", ["Backend", "back end", "a" * 33, "#"])
def test_a_channel_name_must_be_a_plain_name(make_client: MakeClient, name: str) -> None:
    with pytest.raises(ValueError, match="String should match pattern"):
        make_client("alice").join_channel(name)
