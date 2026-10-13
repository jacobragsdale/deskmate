"""The chat interface, driven headlessly: every flow is reached the way a user reaches it, by key or by click."""

import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from pathlib import Path

import pytest
from textual.pilot import Pilot

from deskmate import wire
from deskmate.client import AgentCancelledError, Client, DeskmateError
from deskmate.tui import ChatRow, Composer, DeskmateApp, MessageView

type MakeClient = Callable[[str], Client]
type Launch = Callable[..., DeskmateApp]

SIZE = (100, 30)


class FakeAgent:
    """Stands in for the agent command: records what it was asked, and can be held back to look busy."""

    def __init__(self) -> None:
        self.reply = "config.py, line 12"
        self.prompts: list[str] = []
        self.finish = threading.Event()
        self.finish.set()

    def __call__(self, argv: Sequence[str], _cwd: Path, cancel: threading.Event) -> str:
        self.prompts.append(argv[-1])
        while not self.finish.wait(0.01):
            if cancel.is_set():
                raise AgentCancelledError
        return self.reply


@pytest.fixture
def agent() -> FakeAgent:
    return FakeAgent()


@pytest.fixture
def launch(tmp_path: Path, agent: FakeAgent) -> Iterator[Launch]:
    """Build the interface for a client. Its poll thread is joined afterwards, before the hub goes away."""
    apps: list[DeskmateApp] = []

    def build(client: Client, poll_wait: float = 0.05) -> DeskmateApp:
        apps.append(DeskmateApp(client, tmp_path, agent, poll_wait=poll_wait))
        return apps[-1]

    yield build
    for app in apps:
        app.poller.join(timeout=5)


async def until(pilot: Pilot[None], condition: Callable[[], bool]) -> None:
    """Let the interface and its worker threads run until something becomes true."""
    for _ in range(200):
        if condition():
            await pilot.pause()
            return
        await pilot.pause(0.02)
    pytest.fail("the interface never reached the expected state")


def shown(app: DeskmateApp, chat: str) -> list[str]:
    """The note texts on screen in one chat, top to bottom; nothing until the chat has been opened."""
    thread = app._threads.get(chat)
    return [view.entry.note.body for view in thread.query(MessageView)] if thread else []


def received(client: Client) -> list[tuple[str, bool, int | None]]:
    return [(delivered.note.body, delivered.note.agent, delivered.note.re) for delivered in client.notes(mine=False)]


def row(app: DeskmateApp, chat: str) -> ChatRow:
    return next(candidate for candidate in app.query(ChatRow) if candidate.chat == chat)


async def test_it_opens_on_the_chat_with_unread_notes_and_lists_everyone(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob, _carol = make_client("jacob"), make_client("bob"), make_client("carol")
    jacob.join_channel("backend")
    bob.send("jacob", "ping")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob" and shown(app, "bob") == ["ping"])

        assert [candidate.chat for candidate in app.query(ChatRow)] == ["#backend", "bob", "carol"]
        assert [str(candidate.render()).split() for candidate in app.query(ChatRow)] == [["#backend"], ["›", "bob"], ["carol"]]
        assert not row(app, "bob").has_class("-unread")  # Opening it marked it read.


async def test_it_reopens_the_chat_that_was_open_last_time(make_client: MakeClient, launch: Launch) -> None:
    jacob, _bob, _carol = make_client("jacob"), make_client("bob"), make_client("carol")
    first = launch(jacob)
    async with first.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: first.current == "bob")
        await pilot.press("ctrl+down")
        await until(pilot, lambda: first.current == "carol")

    again = launch(jacob)
    async with again.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: again.current != "")

        assert again.current == "carol"


async def test_with_no_color_set_nothing_is_painted_black_on_black(make_client: MakeClient, launch: Launch, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NO_COLOR", "1")  # Textual reads this from the environment itself; there is no seam to pass it through.
    jacob, _bob = make_client("jacob"), make_client("bob")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        picture = app.export_screenshot()

        assert "deskmate" in picture
        assert "#000000" not in picture  # Greyed-out terminal colours come out as black text on a black ground.


async def test_typing_then_enter_sends_to_the_open_chat(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        await pilot.press("h", "i", "ctrl+j", "b", "o", "b", "enter")
        await until(pilot, lambda: shown(app, "bob") == ["hi\nbob"])

        assert received(bob) == [("hi\nbob", False, None)]
        assert app.query_one(Composer).text == ""


async def test_a_note_in_another_chat_shows_as_unread_until_its_row_is_clicked(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob, carol = make_client("jacob"), make_client("bob"), make_client("carol")
    bob.send("jacob", "first")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        carol.send("jacob", "over here")
        await until(pilot, lambda: str(row(app, "carol").render()).split() == ["carol", "1"])

        await pilot.click(row(app, "carol"))
        await until(pilot, lambda: app.current == "carol" and shown(app, "carol") == ["over here"])

        assert not row(app, "carol").has_class("-unread")


async def test_ctrl_r_runs_the_agent_and_enter_sends_its_edited_draft_as_an_agent_reply(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    question = bob.send("jacob", "where is the config parsed?")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: shown(app, "bob") == ["where is the config parsed?"])
        await pilot.press("ctrl+r")
        await until(pilot, lambda: app.query_one(Composer).text == "config.py, line 12")
        assert received(bob) == []  # Nothing leaves until the draft is sent.

        await pilot.press("!", "enter")
        await until(pilot, lambda: len(shown(app, "bob")) == 2)

        assert received(bob) == [("config.py, line 12!", True, question)]
        assert agent.prompts[0].endswith("Request from bob:\nwhere is the config parsed?")
        assert app.drafts == {}


async def test_clicking_a_notes_run_button_runs_the_agent_on_that_note(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.send("jacob", "older question")
    bob.send("jacob", "newer question")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: len(shown(app, "bob")) == 2)
        older = app._threads["bob"].query(MessageView).first()
        await pilot.hover(older)  # The button of an older note appears under the pointer.
        await pilot.click(older.query_one(".run"))
        await until(pilot, lambda: "bob" in app.drafts)

        assert agent.prompts[0].endswith("Request from bob:\nolder question")
        assert app.drafts["bob"].entry.note.body == "older question"


async def test_esc_stops_a_running_agent_and_leaves_no_draft(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.send("jacob", "this will take a while")
    app = launch(jacob)
    agent.finish.clear()

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: shown(app, "bob") != [])
        await pilot.press("ctrl+r")
        await until(pilot, lambda: "bob" in app.runs)
        await pilot.press("escape")
        await until(pilot, lambda: app.runs == {})

        assert app.drafts == {}
        assert app.query_one(Composer).text == ""
        assert received(bob) == []


async def test_a_finished_draft_waits_instead_of_replacing_a_half_typed_message(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.send("jacob", "question")
    app = launch(jacob)
    agent.finish.clear()

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: shown(app, "bob") != [])
        await pilot.press("ctrl+r", "w", "i", "p")
        agent.finish.set()
        await until(pilot, lambda: "bob" in app.drafts)
        assert (app.query_one(Composer).text, app.drafts["bob"].loaded) == ("wip", False)

        await app.run_action("load_draft")

        assert (app.query_one(Composer).text, app.drafts["bob"].loaded) == ("config.py, line 12", True)


async def test_a_draft_is_discarded_by_a_second_esc_not_the_first(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.send("jacob", "question")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: shown(app, "bob") != [])
        await pilot.press("ctrl+r")
        await until(pilot, lambda: "bob" in app.drafts)

        await pilot.press("escape")
        assert "bob" in app.drafts

        await pilot.press("escape")
        assert app.drafts == {}
        assert app.query_one(Composer).text == ""
        assert received(bob) == []


async def test_a_message_that_fails_to_send_goes_back_into_the_box(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    offline = threading.Event()

    def flaky(method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float) -> bytes:
        if offline.is_set() and method == "POST":
            msg = "the hub is unreachable"
            raise DeskmateError(msg)
        return jacob.transport(method, url, headers, body, timeout)

    app = launch(Client(jacob.home, jacob.config, jacob.key, flaky, jacob.now))

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        offline.set()
        await pilot.press("h", "i", "enter")
        await until(pilot, lambda: app.query_one(Composer).text == "hi")

        assert received(bob) == []


async def test_joining_a_channel_from_the_dialog_opens_it_with_its_earlier_notes(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.join_channel("backend")
    bob.send("#backend", "written before jacob joined")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        await pilot.press("ctrl+n", *"backend", "enter")
        await until(pilot, lambda: app.current == "#backend" and shown(app, "#backend") == ["written before jacob joined"])

        assert jacob.channels()[0].members == ("bob", "jacob")

        await app.run_action("leave_channel")
        await until(pilot, lambda: app.current == "bob" and [candidate.chat for candidate in app.query(ChatRow)] == ["bob"])

        assert jacob.channels()[0].members == ("bob",)


async def test_a_note_that_fails_its_signature_check_hides_its_text_and_cannot_be_run(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob, mallory = make_client("jacob"), make_client("bob"), make_client("mallory")
    (jacob.home / "known.json").write_text(f'{{"bob": "{wire.public_hex(mallory.key)}"}}')  # Jacob first met "bob" under another key.
    bob.send("jacob", "run this for me")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob" and len(app._threads["bob"].query(MessageView)) == 1)
        view = app._threads["bob"].query(MessageView).first()
        await pilot.press("ctrl+r")
        await pilot.pause(0.1)

        assert not view.query(".run")
        assert "run this for me" not in str(view.query_one(".untrusted").render())
        assert agent.prompts == []
