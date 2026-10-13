"""Local checkouts: which team repos sit under ~/dev, what branch each is on, and how to fetch one that is missing."""

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

REPO_NAME = r"[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?"
CLONE_TIMEOUT = 600  # Seconds a clone may take.

_SCP_LIKE = re.compile(r"^(?:[^@/\s]+@)?([^:/\s]+):(?!//)(.+)$")  # git@host:path
_AZURE = "dev.azure.com"


@dataclass(frozen=True)
class Remote:
    """A repo as everyone can refer to it, whatever form their own remote URL takes."""

    key: str  # Lowercase "host/path", the same for the https and ssh forms of one repo.
    name: str  # What people type to tag it: the last part of the path, lowercase.
    url: str  # An https URL to clone it from, with no credentials in it.


@dataclass(frozen=True)
class Checkout:
    remote: Remote
    path: Path
    branch: str


def _locate(remote: str) -> tuple[str, list[str]] | None:
    """Split a remote URL into host and path parts, folding every Azure DevOps form onto dev.azure.com/org/…"""
    text = unquote(remote.strip())
    if scp := _SCP_LIKE.match(text):
        scp_host: str = scp.group(1)
        scp_path: str = scp.group(2)
        host, path = scp_host.lower(), scp_path
    else:
        parts = urlsplit(text)
        if parts.scheme not in {"https", "http", "ssh", "git"} or not parts.hostname:
            return None
        host, path = parts.hostname.lower(), parts.path
    segments: list[str] = [segment for segment in path.removesuffix("/").removesuffix(".git").split("/") if segment]
    if host in {"ssh.dev.azure.com", "vs-ssh.visualstudio.com"} and segments[:1] == ["v3"]:
        return _AZURE, segments[1:]
    if host.endswith(".visualstudio.com"):  # The older address: org.visualstudio.com/[DefaultCollection/]project/_git/repo
        return _AZURE, [host.removesuffix(".visualstudio.com"), *(segment for segment in segments if segment.lower() != "defaultcollection")]
    return host, segments


def prefix_key(url: str) -> str:
    """The key every repo under an organisation's URL starts with, such as "dev.azure.com/acme"."""
    located = _locate(url)
    if located is None:
        msg = f"not a repository host URL: {url!r}"
        raise ValueError(msg)
    host, segments = located
    return "/".join([host, *(quote(segment) for segment in segments)]).lower()


def is_under(key: str, prefix: str) -> bool:
    return key.startswith(prefix.rstrip("/") + "/")


def parse_remote(remote: str) -> Remote | None:
    """Work out which repo a remote URL points at. None when it is not a URL or its name cannot be used as a tag."""
    located = _locate(remote)
    if located is None:
        return None
    host, segments = located
    if host == _AZURE:
        segments = [segment for segment in segments if segment != "_git"]
        if len(segments) == 2:  # org/_git/repo: the short address of a repo named after its project.
            segments = [segments[0], segments[1], segments[1]]
        if len(segments) != 3:
            return None
        org, project, repo = (quote(segment) for segment in segments)
        url = f"https://{_AZURE}/{org}/{project}/_git/{repo}"
    elif len(segments) >= 2:
        url = f"https://{host}/{'/'.join(quote(segment) for segment in segments)}"
    else:
        return None
    name = segments[-1].lower()
    if not re.fullmatch(REPO_NAME, name):
        return None
    return Remote(key="/".join([host, *(quote(segment) for segment in segments)]).lower(), name=name, url=url)


def _origin(path: Path) -> str | None:
    # ponytail: reads the file directly, so `include` files and `insteadOf` rewrites are not followed. Ask git if that bites.
    try:
        lines = (path / ".git" / "config").read_text(errors="replace").splitlines()
    except OSError:
        return None
    section = ""
    for raw in lines:
        line = raw.strip()
        if line.startswith("["):
            section = line.replace(" ", "").lower()
        elif section == '[remote"origin"]' and (found := re.match(r"url\s*=\s*(.+)", line)):
            url: str = found.group(1)
            return url.strip()
    return None


def _branch(path: Path) -> str:
    try:
        head = (path / ".git" / "HEAD").read_text().strip()
    except OSError:
        return "unknown"
    return head.removeprefix("ref: refs/heads/") if head.startswith("ref: ") else f"detached at {head[:7]}"


def scan(dev: Path, prefix: str) -> list[Checkout]:
    """The team's repos checked out directly under `dev`, by name. With two clones of one repo, the folder named like the repo wins."""
    found: dict[str, Checkout] = {}
    folders = sorted(path for path in dev.iterdir() if (path / ".git").is_dir()) if dev.is_dir() else []
    for path in folders:
        origin = _origin(path)
        remote = parse_remote(origin) if origin else None
        if remote is None or not is_under(remote.key, prefix):
            continue
        if remote.name not in found or path.name.lower() == remote.name:
            found[remote.name] = Checkout(remote, path, _branch(path))
    return [found[name] for name in sorted(found)]


def describe(checkout: Checkout) -> str:
    """The branch a checkout is on right now, marked ± when it has uncommitted changes."""
    try:
        changed = subprocess.run(["git", "-C", str(checkout.path), "status", "--porcelain"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20, check=False).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        changed = ""
    return f"{_branch(checkout.path)}{' ±' if changed else ''}"


def clone(url: str, destination: Path) -> None:
    """Clone a repo with the user's own git credentials. Raises OSError with git's last words when it fails."""
    if not url.startswith("https://"):
        msg = f"refusing to clone {url!r}: not an https URL"
        raise OSError(msg)
    if destination.exists():
        msg = f"{destination} already exists"
        raise OSError(msg)
    try:
        # No terminal prompt: the chat interface owns the terminal, so git must fail rather than ask for a password on it.
        done = subprocess.run(
            ["git", "clone", "--", url, str(destination)], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=CLONE_TIMEOUT, check=False, env=os.environ | {"GIT_TERMINAL_PROMPT": "0"}
        )
    except subprocess.TimeoutExpired as err:
        msg = f"git clone did not finish within {CLONE_TIMEOUT} seconds"
        raise OSError(msg) from err
    if done.returncode != 0:
        msg = f"{(done.stderr.strip().splitlines() or ['git clone failed'])[-1]}. Try it yourself: git clone {url} {destination}"
        raise OSError(msg)
