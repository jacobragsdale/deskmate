"""Shared fixtures: an in-process hub with a fixed clock, and clients wired to it without a socket."""

from collections.abc import Callable, Iterator, Mapping
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from deskmate.cli import Client, DeskmateError, Transport, join, load_client
from deskmate.hub import HubSettings, create_app

NOW = 1_800_000_000.0
TOKEN = "a-join-token-for-tests"
HUB_URL = "http://testserver"

type MakeClient = Callable[[str], Client]


def fixed_clock() -> float:
    return NOW


@pytest.fixture
def token() -> str:
    return TOKEN


@pytest.fixture
def hub_url() -> str:
    return HUB_URL


@pytest.fixture
def hub(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(create_app(HubSettings(join_token=TOKEN, db=tmp_path / "hub.db"), now=fixed_clock)) as client:
        yield client


@pytest.fixture
def transport(hub: TestClient) -> Transport:
    def send(method: str, url: str, headers: Mapping[str, str], body: bytes | None, _timeout: float) -> bytes:
        response = hub.request(method, url.removeprefix(HUB_URL), headers=dict(headers), content=body)
        if response.is_error:
            raise DeskmateError(str(response.json()["detail"]))
        return response.content

    return send


@pytest.fixture
def make_client(tmp_path: Path, transport: Transport) -> MakeClient:
    """Join the hub under a name and return a client for that identity."""

    def make(name: str) -> Client:
        home = tmp_path / name
        join(home, HUB_URL, name, TOKEN, "fake-agent", transport)
        return load_client(home, transport, fixed_clock)

    return make
