"""What this implementation signs, parses and tells an agent, written down for the desktop app's TypeScript port to reproduce.

The app's tests read the same file. If the test here fails, the format changed: run `uv run python tests/test_app_vectors.py`, then make the app agree.
"""

import json
from dataclasses import asdict
from pathlib import Path

from deskmate import wire
from deskmate.chat import Entry, agent_prompt, mentions
from deskmate.repos import parse_remote, prefix_key
from deskmate.wire import Kind

VECTORS = Path(__file__).parent.parent / "app" / "test" / "fixtures" / "python-vectors.json"
PRIVATE_KEY = "11" * 32
TS = 1_800_000_000

NOTES: list[tuple[str, str, Kind, str, str | None, int | None]] = [  # sender, to, kind, body, agent, re
    ("jacob", "bob", "note", "hello", None, None),
    ("jacob", "#backend", "note", 'quotes " and \\ and / and <tags>', "uploader", 41),
    ("jacob", "bob", "status", "working\nfeature/retry \u00b1", "acme.billing.api", 7),
    ("jacob", "bob", "note", "tab\there, newline\nhere, return\rhere, bell\x07 backspace\x08 formfeed\x0c unit\x1f del\x7f", None, None),
    ("jacob", "bob", "note", "na\u00efve caf\u00e9 \u2014 \u65e5\u672c\u8a9e \U0001f389 \u2028 line and \u2029 paragraph separators, nbsp\u00a0", None, None),
]

REMOTES = [
    "https://dev.azure.com/acme/Platform/_git/uploader",
    "https://acme@dev.azure.com/acme/Platform/_git/uploader",
    "git@ssh.dev.azure.com:v3/acme/Platform/uploader",
    "ssh://git@ssh.dev.azure.com:22/v3/acme/Platform/uploader",
    "https://acme.visualstudio.com/Platform/_git/uploader",
    "https://acme.visualstudio.com/DefaultCollection/Platform/_git/uploader",
    "acme@vs-ssh.visualstudio.com:v3/acme/Platform/uploader",
    "https://dev.azure.com/acme/_git/uploader",
    "git@ssh.dev.azure.com:v3/acme/Billing%20Core/Acme.Billing.Api",
    "https://github.com/acme/uploader.git",
    "https://user:token@github.com/acme/uploader.git/",
    "git@github.com:Acme/Uploader.git",
    "https://gitlab.example.com:8443/group/sub group/it's (new)!*~.git",
    "https://gitlab.example.com:8443/it's (new)!*~/sub group/repo.git",
    "https://github.com/acme/\u00dcn\u00efcode-repo",
    "https://github.com/acme/100%-done",
    "git://github.com/acme/uploader",
    "https://github.com/uploader",
    "https://github.com/acme/-leading-dash",
    "file:///srv/git/uploader.git",
    "/srv/git/uploader.git",
    "not a url",
    "",
]

PREFIXES = ["https://example.com/it's (new)!*~/", "https://dev.azure.com/acme/", "https://dev.azure.com/acme/Billing Core", "https://github.com/Acme", "git@github.com:acme"]

MENTIONS = [
    "@bob/uploader where do we retry?",
    "@bob/uploader and @carol/uploader, compare. @bob/uploader again",
    "(@bob/up-loader_2)",
    "mail me at jacob@acme/corp or see docs/@bob/uploader",
    "@bob can you look?",
    "@Bob/Uploader. And \u00e9@bob/uploader, and \u65e5\u672c@bob/uploader",
    "ask @bob/acme.billing.api.",
    "",
]


def _entry(note_id: int, sender: str, to: str, body: str, agent: str | None = None) -> Entry:
    return Entry(note_id, wire.sign_note(wire.load_key(PRIVATE_KEY), sender, to, body, TS, agent=agent), trusted=True)


def vectors() -> dict[str, object]:
    key = wire.load_key(PRIVATE_KEY)
    earlier = [_entry(1, "bob", "#backend", "it was the connection pool"), _entry(2, "carol", "#backend", "Retries live in queue.py", agent="uploader")]
    return {
        "private_key": PRIVATE_KEY,
        "public_key": wire.public_hex(key),
        "ts": TS,
        "notes": [wire.sign_note(key, sender, to, body, TS, kind=kind, agent=agent, re=re).model_dump() for sender, to, kind, body, agent, re in NOTES],
        "auth": wire.auth_header(key, "jacob", TS),
        "remotes": [[remote, asdict(parsed) if (parsed := parse_remote(remote)) else None] for remote in REMOTES],
        "prefixes": [[url, prefix_key(url)] for url in PREFIXES],
        "mentions": [[body, [list(found) for found in mentions(body)]] for body in MENTIONS],
        "prompts": [
            {"review": True, "prompt": agent_prompt(_entry(3, "bob", "#backend", "@jacob/uploader where do we retry?"), "jacob", "uploader", earlier, review=True)},
            {"review": False, "prompt": agent_prompt(_entry(3, "bob", "jacob", "@jacob/uploader where do we retry?"), "jacob", "uploader", [], review=False)},
            {"review": False, "prompt": agent_prompt(_entry(3, "jacob", "bob", "@jacob/uploader where do we retry?"), "jacob", "uploader", [], review=False)},
        ],
    }


def test_the_vectors_the_app_is_tested_against_are_what_this_implementation_produces() -> None:
    assert json.loads(VECTORS.read_text()) == vectors()


if __name__ == "__main__":
    VECTORS.write_text(json.dumps(vectors(), ensure_ascii=False, indent=1) + "\n")
