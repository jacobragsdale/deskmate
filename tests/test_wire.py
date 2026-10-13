import pytest
from pydantic import ValidationError

from deskmate import wire
from deskmate.wire import MAX_BODY, MAX_SKEW, Note

KEY = wire.new_key()
OTHER_KEY = wire.new_key()
TS = 1_800_000_000
NOTE = wire.sign_note(KEY, "alice", "bob", "hello", TS)


def test_a_note_verifies_against_its_senders_key() -> None:
    assert wire.note_is_authentic(NOTE, wire.public_hex(KEY))


@pytest.mark.parametrize("change", [{"body": "hello!"}, {"to": "carol"}, {"to": "#bob"}, {"sender": "mallory"}, {"ts": TS + 1}, {"agent": "uploader"}, {"kind": "status"}, {"re": 7}])
def test_changing_any_signed_field_breaks_the_signature(change: dict[str, object]) -> None:
    forged = Note.model_validate(NOTE.model_dump() | change)

    assert not wire.note_is_authentic(forged, wire.public_hex(KEY))


def test_a_note_does_not_verify_against_another_key() -> None:
    assert not wire.note_is_authentic(NOTE, wire.public_hex(OTHER_KEY))


@pytest.mark.parametrize(
    "change",
    [
        {"body": ""},
        {"body": "x" * (MAX_BODY + 1)},
        {"sender": "Alice"},
        {"sender": "#alice"},
        {"to": "bob smith"},
        {"to": "##backend"},
        {"sig": "not-hex"},
        {"ts": "1800000000"},
        {"agent": "Not A Repo"},
        {"agent": True},
        {"kind": "memo"},
        {"extra": 1},
    ],
)
def test_note_rejects_malformed_fields(change: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        Note.model_validate(NOTE.model_dump() | change)


@pytest.mark.parametrize("change", [{"body": "x" * MAX_BODY}, {"to": "#backend"}, {"re": 12}, {"agent": "acme.billing.api"}])
def test_note_accepts_values_at_the_edge_of_what_is_allowed(change: dict[str, object]) -> None:
    assert Note.model_validate(NOTE.model_dump() | change)


@pytest.mark.parametrize(("offset", "fresh"), [(0, True), (MAX_SKEW, True), (-MAX_SKEW, True), (MAX_SKEW + 1, False), (-MAX_SKEW - 1, False)])
def test_freshness_window(offset: int, fresh: bool) -> None:
    assert wire.is_fresh(TS, TS + offset) is fresh


def test_auth_header_round_trips() -> None:
    claim = wire.auth_claim(wire.auth_header(KEY, "alice", TS))

    assert claim is not None
    name, ts, sig = claim
    assert (name, ts) == ("alice", TS)
    assert wire.auth_is_valid(name, ts, sig, wire.public_hex(KEY), now=TS)


@pytest.mark.parametrize(
    ("name", "key", "now"),
    [
        ("bob", KEY, TS),  # Signed for alice, presented as bob.
        ("alice", OTHER_KEY, TS),  # Checked against someone else's key.
        ("alice", KEY, TS + MAX_SKEW + 1),  # Replayed after the window closed.
    ],
)
def test_auth_is_rejected(name: str, key: wire.Ed25519PrivateKey, now: int) -> None:
    claim = wire.auth_claim(wire.auth_header(KEY, "alice", TS))
    assert claim is not None

    assert not wire.auth_is_valid(name, claim[1], claim[2], wire.public_hex(key), now=now)


@pytest.mark.parametrize("header", ["", "Bearer abc", "Deskmate alice", "Deskmate alice:soon:ff", "Deskmate alice:" + "9" * 13 + ":ff"])
def test_auth_claim_refuses_headers_it_cannot_parse(header: str) -> None:
    assert wire.auth_claim(header) is None
