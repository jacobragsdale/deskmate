import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from deskmate.repos import Checkout, Remote, clone, describe, is_under, parse_remote, prefix_key, scan

type MakeCheckout = Callable[..., Path]

UPLOADER = Remote(key="dev.azure.com/acme/platform/uploader", name="uploader", url="https://dev.azure.com/acme/Platform/_git/uploader")


@pytest.mark.parametrize(
    "remote",
    [
        "https://dev.azure.com/acme/Platform/_git/uploader",
        "https://acme@dev.azure.com/acme/Platform/_git/uploader",  # The user name Azure DevOps puts in its clone URLs.
        "https://jacob:a-personal-access-token@dev.azure.com/acme/Platform/_git/uploader",
        "git@ssh.dev.azure.com:v3/acme/Platform/uploader",
        "ssh://git@ssh.dev.azure.com:22/v3/acme/Platform/uploader",
        "https://acme.visualstudio.com/Platform/_git/uploader",
        "https://acme.visualstudio.com/DefaultCollection/Platform/_git/uploader",
        "acme@vs-ssh.visualstudio.com:v3/acme/Platform/uploader",
    ],
)
def test_every_azure_devops_form_of_one_repo_is_the_same_repo_with_a_clean_clone_url(remote: str) -> None:
    assert parse_remote(remote) == UPLOADER


@pytest.mark.parametrize(
    ("remote", "expected"),
    [
        ("https://github.com/acme/uploader.git", Remote("github.com/acme/uploader", "uploader", "https://github.com/acme/uploader")),
        ("git@github.com:Acme/Uploader.git", Remote("github.com/acme/uploader", "uploader", "https://github.com/Acme/Uploader")),
        ("https://dev.azure.com/acme/_git/uploader", Remote("dev.azure.com/acme/uploader/uploader", "uploader", "https://dev.azure.com/acme/uploader/_git/uploader")),
        (
            "git@ssh.dev.azure.com:v3/acme/Billing%20Core/Acme.Billing.Api",
            Remote("dev.azure.com/acme/billing%20core/acme.billing.api", "acme.billing.api", "https://dev.azure.com/acme/Billing%20Core/_git/Acme.Billing.Api"),
        ),
    ],
)
def test_parse_remote(remote: str, expected: Remote) -> None:
    assert parse_remote(remote) == expected


@pytest.mark.parametrize("remote", ["", "not a url", "/srv/git/uploader.git", "https://github.com/uploader", "https://dev.azure.com/acme/Platform/_git/My%20Repo", "file:///srv/git/acme/uploader"])
def test_a_remote_that_names_no_taggable_repo_is_skipped(remote: str) -> None:
    assert parse_remote(remote) is None


@pytest.mark.parametrize(
    ("url", "key"), [("https://dev.azure.com/Acme/", "dev.azure.com/acme"), ("https://acme.visualstudio.com", "dev.azure.com/acme"), ("https://github.com/acme", "github.com/acme")]
)
def test_prefix_key(url: str, key: str) -> None:
    assert prefix_key(url) == key


@pytest.mark.parametrize(
    ("key", "inside"), [("dev.azure.com/acme/platform/uploader", True), ("dev.azure.com/acme-other/platform/uploader", False), ("dev.azure.com/acme", False), ("github.com/acme/uploader", False)]
)
def test_is_under(key: str, inside: bool) -> None:
    assert is_under(key, "dev.azure.com/acme") is inside


def test_scan_finds_the_teams_repos_and_nothing_else(tmp_path: Path, checkout: MakeCheckout) -> None:
    checkout(tmp_path, "uploader", "git@ssh.dev.azure.com:v3/acme/Platform/uploader", "ref: refs/heads/feature/retry")
    checkout(tmp_path, "billing", "https://dev.azure.com/acme/Billing/_git/Acme.Billing.Api", "0123456789abcdef0123456789abcdef01234567")
    checkout(tmp_path, "side-project", "https://github.com/jacob/side-project.git")
    (tmp_path / "notes").mkdir()
    (tmp_path / "nested" / "deeper").mkdir(parents=True)
    checkout(tmp_path / "nested", "deeper-repo", "https://dev.azure.com/acme/Platform/_git/hidden")

    found = scan(tmp_path, "dev.azure.com/acme")

    assert [(c.remote.name, c.path.name, c.branch) for c in found] == [("acme.billing.api", "billing", "detached at 0123456"), ("uploader", "uploader", "feature/retry")]


def test_with_two_clones_of_one_repo_the_folder_named_like_it_wins(tmp_path: Path, checkout: MakeCheckout) -> None:
    checkout(tmp_path, "a-scratch-copy", "https://dev.azure.com/acme/Platform/_git/uploader")
    checkout(tmp_path, "uploader", "https://dev.azure.com/acme/Platform/_git/uploader")
    checkout(tmp_path, "uploader-handoff", "https://dev.azure.com/acme/Platform/_git/uploader")

    assert [c.path.name for c in scan(tmp_path, "dev.azure.com/acme")] == ["uploader"]


def test_scan_of_a_missing_folder_is_empty(tmp_path: Path) -> None:
    assert scan(tmp_path / "no-such-dev", "dev.azure.com/acme") == []


def test_describe_marks_uncommitted_changes(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "--quiet", "--initial-branch", "feature/retry", str(tmp_path)], check=True)
    here = Checkout(UPLOADER, tmp_path, "feature/retry")

    clean = describe(here)
    (tmp_path / "wip.txt").write_text("not committed")

    assert (clean, describe(here)) == ("feature/retry", "feature/retry ±")


@pytest.mark.parametrize("url", ["git@github.com:acme/uploader.git", "--upload-pack=touch /tmp/owned", "file:///etc"])
def test_clone_refuses_anything_but_an_https_url(tmp_path: Path, url: str) -> None:
    with pytest.raises(OSError, match="not an https URL"):
        clone(url, tmp_path / "uploader")


def test_clone_refuses_to_write_over_an_existing_folder(tmp_path: Path) -> None:
    with pytest.raises(OSError, match="already exists"):
        clone("https://dev.azure.com/acme/Platform/_git/uploader", tmp_path)
