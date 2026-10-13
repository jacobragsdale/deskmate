"""Wire format shared by the hub and the client: signed notes and signed request headers."""

import json
from typing import Annotated

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from pydantic import BaseModel, ConfigDict, StringConstraints

MAX_BODY = 64_000
MAX_SKEW = 300  # Seconds a signed timestamp may differ from the verifier's clock.
AUTH_SCHEME = "Deskmate"

Name = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$")]
PubKey = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Signature = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{128}$")]


class Model(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True, validate_default=True, revalidate_instances="always", allow_inf_nan=False)


class User(Model):
    name: Name
    pubkey: PubKey


class Join(User):
    token: str


class Note(Model):
    """A message signed by its sender. The hub relays it unchanged, so the recipient can verify it too."""

    sender: Name
    to: Name
    body: Annotated[str, StringConstraints(min_length=1, max_length=MAX_BODY)]
    ts: int  # Unix seconds, UTC.
    sig: Signature


class Delivered(Model):
    id: int
    note: Note


class Receipt(Model):
    id: int


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


def _note_payload(sender: str, to: str, body: str, ts: int) -> bytes:
    # A JSON array of fixed positions has exactly one encoding, so both sides sign the same bytes.
    return json.dumps(["deskmate-note-v1", sender, to, body, ts], ensure_ascii=False, separators=(",", ":")).encode()


def sign_note(key: Ed25519PrivateKey, sender: str, to: str, body: str, ts: int) -> Note:
    return Note(sender=sender, to=to, body=body, ts=ts, sig=key.sign(_note_payload(sender, to, body, ts)).hex())


def note_is_authentic(note: Note, pubkey: str) -> bool:
    return verify(pubkey, _note_payload(note.sender, note.to, note.body, note.ts), note.sig)


def _auth_payload(name: str, ts: int) -> bytes:
    return f"deskmate-auth-v1:{name}:{ts}".encode()


def auth_header(key: Ed25519PrivateKey, name: str, ts: int) -> str:
    """Prove who is asking. It gates reads only: every note carries its own signature."""
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
