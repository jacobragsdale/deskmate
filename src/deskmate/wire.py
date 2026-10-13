"""Wire format shared by the hub and the client: signed notes and signed request headers."""

import json
from typing import Annotated

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from pydantic import BaseModel, ConfigDict, StringConstraints

MAX_BODY = 64_000
MAX_SKEW = 300  # Seconds a signed timestamp may differ from the verifier's clock.
AUTH_SCHEME = "Deskmate"

_NAME = r"[a-z0-9][a-z0-9_-]{0,31}"
Name = Annotated[str, StringConstraints(pattern=rf"^{_NAME}$")]
Channel = Annotated[str, StringConstraints(pattern=rf"^#{_NAME}$")]
Address = Annotated[str, StringConstraints(pattern=rf"^#?{_NAME}$")]  # A person, or a channel when it starts with "#".
PubKey = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Signature = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{128}$")]


class Model(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True, validate_default=True, revalidate_instances="always", allow_inf_nan=False)


class User(Model):
    name: Name
    pubkey: PubKey


class Join(User):
    token: str


class ChannelInfo(Model):
    name: Channel
    members: tuple[Name, ...]


class Note(Model):
    """A message signed by its sender. The hub relays it unchanged, so every recipient can verify it too."""

    sender: Name
    to: Address
    body: Annotated[str, StringConstraints(min_length=1, max_length=MAX_BODY)]
    ts: int  # Unix seconds, UTC.
    agent: bool  # Written by the sender's agent (and approved by the sender) rather than typed.
    re: int | None  # The id of the note this one answers; None when it answers nothing.
    sig: Signature


class Delivered(Model):
    id: int
    note: Note


class Receipt(Model):
    id: int


def is_channel(address: str) -> bool:
    return address.startswith("#")


def new_key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.generate()


def load_key(private_hex: str) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_hex))


def private_hex(key: Ed25519PrivateKey) -> str:
    return key.private_bytes_raw().hex()


def public_hex(key: Ed25519PrivateKey) -> str:
    return key.public_key().public_bytes_raw().hex()


def verify(pubkey: str, payload: bytes, sig: str) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(pubkey)).verify(bytes.fromhex(sig), payload)
    except (InvalidSignature, ValueError):
        return False
    return True


def is_fresh(ts: int, now: float) -> bool:
    return abs(now - ts) <= MAX_SKEW


def _note_payload(sender: str, to: str, body: str, ts: int, agent: bool, re: int | None) -> bytes:
    # A JSON array of fixed positions has exactly one encoding, so both sides sign the same bytes.
    return json.dumps(["deskmate-note-v2", sender, to, body, ts, agent, re], ensure_ascii=False, separators=(",", ":")).encode()


def sign_note(key: Ed25519PrivateKey, sender: str, to: str, body: str, ts: int, *, agent: bool = False, re: int | None = None) -> Note:
    return Note(sender=sender, to=to, body=body, ts=ts, agent=agent, re=re, sig=key.sign(_note_payload(sender, to, body, ts, agent, re)).hex())


def note_is_authentic(note: Note, pubkey: str) -> bool:
    return verify(pubkey, _note_payload(note.sender, note.to, note.body, note.ts, note.agent, note.re), note.sig)


def _auth_payload(name: str, ts: int) -> bytes:
    return f"deskmate-auth-v1:{name}:{ts}".encode()


def auth_header(key: Ed25519PrivateKey, name: str, ts: int) -> str:
    """Prove who is asking. It gates reads and channel membership: every note carries its own signature."""
    return f"{AUTH_SCHEME} {name}:{ts}:{key.sign(_auth_payload(name, ts)).hex()}"


def auth_claim(header: str) -> tuple[str, int, str] | None:
    """Split an auth header into (name, ts, sig) without trusting it yet."""
    scheme, _, rest = header.partition(" ")
    name, ts, sig = (*rest.split(":"), "", "")[:3]
    if scheme != AUTH_SCHEME or not ts.isascii() or not ts.isdigit() or len(ts) > 12:
        return None
    return name, int(ts), sig


def auth_is_valid(name: str, ts: int, sig: str, pubkey: str, now: float) -> bool:
    return is_fresh(ts, now) and verify(pubkey, _auth_payload(name, ts), sig)
