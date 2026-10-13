"""The chat interface, driven headlessly: every flow is reached the way a user reaches it, by key or by click."""

import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from pathlib import Path

import pytest
from textual.pilot import Pilot
from textual.widgets import OptionList

from deskmate import wire
from deskmate.client import AgentCancelledError, Client, DeskmateError
from deskmate.repos import Checkout
from deskmate.tui import DeskmateApp
from deskmate.widgets import ChatRow, Composer, ConfirmClone, Hint, MessageView
from deskmate.wire import Repo

type MakeClient = Callable[[str], Client]
type MakeCheckout = Callable[..., Path]
type Launch = Callable[..., DeskmateApp]
type Dev = Callable[..., Path]

SIZE = (150, 34)  # Wide enough that the choices under a note stay on one line, so a click can be aimed at one.
PLATFORM = "https://dev.azure.com/acme/Platform/_git"


def shared(name: str, branch: str = "main") -> Repo:
    return Repo(name=name, key=f"dev.azure.com/acme/platform/{name}", url=f"{PLATFORM}/{name}", branch=branch)


class FakeAgent:
    """Stands in for the agent command: records what it was asked and where, and can be held back to look busy."""

    def __init__(self) -> None:
        self.reply = "config.py, line 12"
        self.prompts: list[str] = []
        self.folders: list[Path] = []
        self.finish = threading.Event()
        self.finish.set()

    def __call__(self, argv: Sequence[str], cwd: Path, cancel: threading.Event) -> str:
        self.prompts.append(argv[-1])
        self.folders.append(cwd)
        while not self.finish.wait(0.01):
            if cancel.is_set():
                raise AgentCancelledError
        return self.reply


@pytest.fixture
def agent() -> FakeAgent:
    return FakeAgent()


@pytest.fixture
def dev(tmp_path: Path, checkout: MakeCheckout) -> Dev:
    """A person's ~/dev, holding checkouts of the named team repos."""

    def make(person: str, *repos: str) -> Path:
        folder = tmp_path / f"{person}-dev"
        folder.mkdir(exist_ok=True)
        for repo in repos:
            checkout(folder, repo, f"{PLATFORM}/{repo}")
        return folder

    return make


@pytest.fixture
def cloned() -> list[tuple[str, Path]]:
    """What the interface was asked to clone. The stand-in cloner lays a checkout down where the real one would."""
    return []


@pytest.fixture
def launch(agent: FakeAgent, dev: Dev, cloned: list[tuple[str, Path]], checkout: MakeCheckout) -> Iterator[Launch]:
    """Build the interface for a client. Its poll thread is joined afterwards, before the hub goes away."""
    apps: list[DeskmateApp] = []

    def clone(url: str, destination: Path) -> None:
        cloned.append((url, destination))
        checkout(destination.parent, destination.name, url)

    def describe(where: Checkout) -> str:
        return f"{where.branch} ±"

    def build(client: Client, *repos: str, poll_wait: float = 0.05) -> DeskmateApp:
        apps.append(DeskmateApp(client, dev(client.config.name, *repos), agent, cloner=clone, describe=describe, poll_wait=poll_wait))
        return apps[-1]

    yield build
    for app in apps:
        app.poller.join(timeout=5)


async def until(pilot: Pilot[None], condition: Callable[[], bool]) -> None:
    """Let the interface and its worker threads run until something becomes true."""
    for _ in range(250):
        if condition():
            await pilot.pause()
            return
        await pilot.pause(0.02)
    pytest.fail("the interface never reached the expected state")


def shown(app: DeskmateApp, chat: str) -> list[str]:
    """The note texts on screen in one chat, top to bottom; nothing until the chat has been opened."""
    thread = app._threads.get(chat)
    return [view.entry.note.body for view in thread.query(MessageView)] if thread else []


def under(app: DeskmateApp, chat: str, note_id: int) -> str:
    """The status line under a note that tags an agent, as plain text; "" when there is none."""
    thread = app._threads.get(chat)
    view = thread.tagging.get(note_id) if thread else None
    return str(view.bar.render()) if view else ""


def received(client: Client) -> list[tuple[str, str | None, int | None]]:
    return [(delivered.note.body, delivered.note.agent, delivered.note.re) for delivered in client.notes(mine=False, status=False)]


def reports(client: Client) -> list[str]:
    """The agent status reports other people have sent this client, oldest first."""
    return [delivered.note.body for delivered in client.notes(mine=False) if delivered.note.kind == "status"]


def row(app: DeskmateApp, chat: str) -> list[str]:
    """One line of the chat list, as the words on it."""
    return next(str(candidate.render()).split() for candidate in app.query(ChatRow) if candidate.chat == chat)


def hints(app: DeskmateApp) -> list[str]:
    """The key hints showing in the bottom bar, left to right."""
    return [str(hint.render()) for hint in app.query(Hint) if hint.has_class("-on")]


def layout(app: DeskmateApp, chat: str) -> list[str]:
    """What a chat shows, top to bottom: note texts, with dividers in their places."""
    return [child.entry.note.body if isinstance(child, MessageView) else str(child.render()) for child in app._threads[chat].children]


async def say(pilot: Pilot[None], app: DeskmateApp, text: str) -> None:
    """Put text in the message box and send it."""
    app.query_one(Composer).set_text(text)
    await pilot.press("enter")


async def test_it_opens_on_the_chat_with_unread_notes_and_shows_who_is_here(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob, carol = make_client("jacob"), make_client("bob"), make_client("carol")
    jacob.join_channel("backend")
    carol.users()  # Any signed request marks carol as here; bob has only joined.
    bob.send("jacob", "ping")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob" and shown(app, "bob") == ["ping"])

        assert [str(candidate.render()).split() for candidate in app.query(ChatRow)] == [["#backend"], ["›", "○", "bob"], ["●", "carol"]]


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

        assert received(bob) == [("hi\nbob", None, None)]
        assert app.query_one(Composer).text == ""


async def test_a_note_in_another_chat_shows_as_unread_until_its_row_is_clicked(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob, carol = make_client("jacob"), make_client("bob"), make_client("carol")
    bob.send("jacob", "first")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        carol.send("jacob", "over here")
        await until(pilot, lambda: row(app, "carol") == ["○", "carol", "1"])

        await pilot.click(next(candidate for candidate in app.query(ChatRow) if candidate.chat == "carol"))
        await until(pilot, lambda: app.current == "carol" and shown(app, "carol") == ["over here"])

        assert row(app, "carol") == ["›", "○", "carol"]


async def test_the_repos_under_dev_are_shared_with_their_branches(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    app = launch(jacob, "uploader", "billing")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: sorted(app.checkouts) == ["billing", "uploader"])

        assert [(repo.user, repo.name, repo.branch) for repo in bob.repos()] == [("jacob", "billing", "main"), ("jacob", "uploader", "main")]


async def test_tagging_my_own_agent_runs_it_at_once_and_posts_its_answer(make_client: MakeClient, launch: Launch, agent: FakeAgent, dev: Dev) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob" and "uploader" in app.checkouts)
        await say(pilot, app, "@jacob/uploader where is the config parsed?")
        await until(pilot, lambda: len(shown(app, "bob")) == 2)

        (question, answer) = jacob.notes(status=False)
        assert received(bob) == [("@jacob/uploader where is the config parsed?", None, None), ("config.py, line 12", "uploader", question.id)]
        assert answer.note.agent == "uploader"
        assert agent.folders == [dev("jacob") / "uploader"]
        assert "with nobody reviewing it first" in agent.prompts[0]
        assert reports(bob) == ["working\nmain ±"]
        assert app.drafts == {}


async def test_a_teammates_tag_waits_until_i_run_it_and_i_review_the_draft_before_it_goes(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    question = bob.send("jacob", "@jacob/uploader where is the config parsed?")
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: "your uploader agent · ▶ Run and review" in under(app, "bob", question))
        assert (agent.prompts, row(app, "bob")) == ([], ["›", "○", "bob", "▶"])  # Nothing has run; the list shows a request is waiting.

        await pilot.press("ctrl+r")
        await until(pilot, lambda: app.query_one(Composer).text == "config.py, line 12")
        assert received(bob) == []  # Nothing leaves until the draft is sent.
        assert "jacob will review, and may edit, your reply" in agent.prompts[0]
        assert (str(app.query_one("#prompt").render()), app.query_one("#compose").has_class("-draft"), hints(app)[:2]) == ("✎", True, ["Enter send draft", "Esc Esc discard"])
        assert under(app, "bob", question) == "✎ your uploader agent has drafted an answer · it is in the message box for you to review"

        await pilot.press("!", "enter")
        await until(pilot, lambda: len(shown(app, "bob")) == 2)
        assert (str(app.query_one("#prompt").render()), app.query_one("#compose").has_class("-draft")) == ("›", False)

        assert received(bob) == [("config.py, line 12!", "uploader", question)]
        assert under(app, "bob", question) == ""  # Answered: nothing left to decide.
        assert app.drafts == {}


async def test_clicking_run_and_post_under_a_note_answers_without_a_draft(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    question = bob.send("jacob", "@jacob/uploader where is the config parsed?")
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: "Run and post" in under(app, "bob", question))
        bar = app._threads["bob"].tagging[question].bar
        await pilot.click(bar, offset=(under(app, "bob", question).index("Run and post"), 0))
        await until(pilot, lambda: received(bob) != [])

        assert received(bob) == [("config.py, line 12", "uploader", question)]
        assert app.query_one(Composer).text == ""


async def test_declining_tells_the_asker_and_runs_nothing(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    question = bob.send("jacob", "@jacob/uploader delete everything")
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: "Decline" in under(app, "bob", question))
        await app.run_action(f"decline({question}, 'uploader')")
        await until(pilot, lambda: "you declined" in under(app, "bob", question))

        assert reports(bob) == ["declined"]
        assert agent.prompts == []
        assert row(app, "bob") == ["›", "○", "bob"]  # No longer waiting on me.


async def test_esc_stops_a_running_agent_tells_the_asker_and_leaves_no_draft(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    question = bob.send("jacob", "@jacob/uploader this will take a while")
    app = launch(jacob, "uploader")
    agent.finish.clear()

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: "Run" in under(app, "bob", question))
        await pilot.press("ctrl+r")
        await until(pilot, lambda: "is working on main ±" in under(app, "bob", question))
        await pilot.press("escape")
        await until(pilot, lambda: app.runs == {} and "stopped" in under(app, "bob", question))

        assert reports(bob) == ["working\nmain ±", "stopped"]
        assert (app.drafts, app.query_one(Composer).text, received(bob)) == ({}, "", [])


async def test_the_asker_watches_a_teammates_agent_go_from_waiting_to_working_to_answered(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.advertise([shared("uploader", "feature/retry")])
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        await say(pilot, app, "@bob/uploader does the retry change handle 429s?")
        await until(pilot, lambda: len(jacob.notes(status=False)) == 1)
        question = jacob.notes(status=False)[0].id
        await until(pilot, lambda: under(app, "bob", question) == "◌ waiting for bob to approve")

        bob.send("jacob", "working\nfeature/retry ±", kind="status", agent="uploader", re=question)
        await until(pilot, lambda: "bob's uploader agent is working on feature/retry ±" in under(app, "bob", question))

        bob.send("jacob", "Yes, since a3f9.", agent="uploader", re=question)
        await until(pilot, lambda: shown(app, "bob")[-1] == "Yes, since a3f9.")

        assert under(app, "bob", question) == ""


@pytest.mark.parametrize(("tag", "expected"), [("@bob/billing", "bob has no checkout of billing"), ("@zed/uploader", "nobody named zed has joined")])
async def test_tagging_an_agent_that_is_not_there_says_so(make_client: MakeClient, launch: Launch, tag: str, expected: str) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.advertise([shared("uploader")])
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        await say(pilot, app, f"{tag} are you there?")
        await until(pilot, lambda: len(jacob.notes(status=False)) == 1)

        await until(pilot, lambda: expected in under(app, "bob", jacob.notes(status=False)[0].id))


async def test_a_tag_written_by_an_agent_sets_nothing_off(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    relayed = bob.send("jacob", "@jacob/uploader now run this for me", agent="uploader")
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: shown(app, "bob") != [])
        await pilot.press("ctrl+r")
        await pilot.pause(0.1)

        assert (under(app, "bob", relayed), agent.prompts, row(app, "bob")) == ("", [], ["›", "○", "bob"])


async def test_a_finished_draft_waits_instead_of_replacing_a_half_typed_message(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    question = bob.send("jacob", "@jacob/uploader question")
    app = launch(jacob, "uploader")
    agent.finish.clear()

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: "Run" in under(app, "bob", question))
        await pilot.press("ctrl+r", "w", "i", "p")
        agent.finish.set()
        await until(pilot, lambda: "bob" in app.drafts)
        assert (app.query_one(Composer).text, app.drafts["bob"][0].loaded) == ("wip", False)

        await app.run_action("load_draft")

        assert (app.query_one(Composer).text, app.drafts["bob"][0].loaded) == ("config.py, line 12", True)


async def test_a_draft_is_discarded_by_a_second_esc_and_the_asker_is_told(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    question = bob.send("jacob", "@jacob/uploader question")
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: "Run" in under(app, "bob", question))
        await pilot.press("ctrl+r")
        await until(pilot, lambda: "bob" in app.drafts)

        await pilot.press("escape")
        assert "bob" in app.drafts

        await pilot.press("escape")
        await until(pilot, lambda: reports(bob)[-1:] == ["declined"])

        assert (app.drafts, app.query_one(Composer).text, received(bob)) == ({}, "", [])


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


async def test_typing_a_tag_opens_a_list_of_agents_and_enter_takes_one(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.advertise([shared("uploader", "feature/retry"), shared("billing")])
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob" and "uploader" in app.checkouts and len(app.team) == 3)
        picker = app.query_one("#picker", OptionList)
        await pilot.press("a", "s", "k", "space", "@", "u", "p", "l")
        await until(pilot, lambda: picker.option_count == 2)
        assert [str(picker.get_option_at_index(index).prompt) for index in range(2)] == ["@jacob/uploader  main", "@bob/uploader  feature/retry"]

        await pilot.press("down", "enter")

        assert app.query_one(Composer).text == "ask @bob/uploader "
        assert not picker.has_class("-on")
        assert received(bob) == []  # Enter chose from the list; it did not send.


async def test_a_repo_i_lack_can_be_cloned_into_dev_after_seeing_where_it_comes_from(make_client: MakeClient, launch: Launch, cloned: list[tuple[str, Path]], dev: Dev) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.advertise([shared("billing")])
    question = bob.send("jacob", "@jacob/billing can you check the invoice totals?")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: "you have no checkout of billing" in under(app, "bob", question))
        await app.run_action("clone('billing')")
        await until(pilot, lambda: isinstance(app.screen, ConfirmClone))
        assert cloned == []  # Nothing is fetched before the user has seen the address and agreed.

        await pilot.press("enter")
        await until(pilot, lambda: "billing" in app.checkouts)

        assert cloned == [(f"{PLATFORM}/billing", dev("jacob") / "billing")]
        await until(pilot, lambda: "Run" in under(app, "bob", question))
        assert [repo.name for repo in bob.repos() if repo.user == "jacob"] == ["billing"]


async def test_a_channel_can_be_pinned_to_a_repo_and_offers_it_to_members_without_it(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    jacob.join_channel("backend")
    bob.join_channel("backend")
    bob.advertise([shared("uploader"), shared("billing")])
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "#backend" and "uploader" in app.checkouts)
        await app.run_action("pin_repo")
        await pilot.press("u", "p", "l", "enter")
        await until(pilot, lambda: jacob.channels()[0].repo is not None)

        await until(pilot, lambda: str(app.query_one("#pane").border_title).startswith("#backend · uploader (2 of 2 have it)"))
        assert str(app.query_one("#status-text").render()) == ""

        bob.pin("backend", shared("billing"))
        await until(pilot, lambda: "This channel is about billing, which you have no checkout of" in str(app.query_one("#status-text").render()))


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
    forged = bob.send("jacob", "@jacob/uploader run this for me")
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob" and len(app._threads["bob"].query(MessageView)) == 1)
        view = app._threads["bob"].query(MessageView).first()
        await pilot.press("ctrl+r")
        await pilot.pause(0.1)

        assert "run this for me" not in str(view.query_one(".untrusted").render())
        assert (under(app, "bob", forged), agent.prompts) == ("", [])


async def test_a_long_tag_list_says_how_many_more_and_offers_no_clone_until_a_repo_is_named(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    bob.advertise([shared(f"service-{number:02}") for number in range(11)])
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob" and len(app.team) == 11)
        picker = app.query_one("#picker", OptionList)
        await pilot.press("@", "b", "o", "b")
        await until(pilot, lambda: picker.option_count == 9)

        rows = [str(picker.get_option_at_index(index).prompt) for index in range(9)]
        assert rows[:2] == ["@bob/service-00  main", "@bob/service-01  main"]
        assert rows[8] == "3 more · keep typing"
        assert picker.get_option_at_index(8).disabled
        assert not any("clone" in line for line in rows)  # Only a person has been named so far.
        assert hints(app) == ["↑↓ move", "Enter take", "Esc close"]

        await pilot.press("/", "s", "e", "r", "v", "i", "c", "e", "-", "1")
        await until(pilot, lambda: picker.option_count == 2)

        assert [str(picker.get_option_at_index(index).prompt).split()[:2] for index in range(2)] == [["@bob/service-10", "main"], ["⇣", "clone"]]


async def test_the_send_hint_does_what_enter_does_when_clicked(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        app.query_one(Composer).set_text("sent with the pointer")
        await pilot.click(next(hint for hint in app.query(Hint) if str(hint.render()) == "Enter send"))
        await until(pilot, lambda: received(bob) != [])

        assert received(bob) == [("sent with the pointer", None, None)]


async def test_up_in_an_empty_box_brings_back_the_last_message_sent_in_that_chat(make_client: MakeClient, launch: Launch) -> None:
    jacob, _bob, _carol = make_client("jacob"), make_client("bob"), make_client("carol")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        await say(pilot, app, "to bob, with a typo")
        await until(pilot, lambda: shown(app, "bob") == ["to bob, with a typo"])
        await pilot.press("up")
        assert app.query_one(Composer).text == "to bob, with a typo"

        await pilot.press("ctrl+down")
        await until(pilot, lambda: app.current == "carol")
        await pilot.press("up")

        assert app.query_one(Composer).text == ""  # Nothing was sent to carol.


async def test_a_line_marks_where_i_left_off_until_i_have_been_and_gone(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob, _carol = make_client("jacob"), make_client("bob"), make_client("carol")
    bob.send("jacob", "seen last time")
    first = launch(jacob)
    async with first.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: shown(first, "bob") == ["seen last time"])
        assert "── new ──" not in layout(first, "bob")  # A chat opened for the first time has no "left off".

    bob.send("jacob", "arrived while away")
    bob.send("jacob", "and another")
    app = launch(jacob)
    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: len(shown(app, "bob")) == 3)
        assert layout(app, "bob")[1:] == ["seen last time", "── new ──", "arrived while away", "and another"]

        await pilot.press("ctrl+down")
        await until(pilot, lambda: app.current == "carol")
        bob.send("jacob", "arrived while elsewhere")
        await until(pilot, lambda: row(app, "bob") == ["○", "bob", "1"])
        await pilot.press("ctrl+up")
        await until(pilot, lambda: len(shown(app, "bob")) == 4)

        assert layout(app, "bob")[1:] == ["seen last time", "arrived while away", "and another", "── new ──", "arrived while elsewhere"]


async def test_the_chat_list_can_be_hidden_and_stays_hidden_next_time(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob, carol = make_client("jacob"), make_client("bob"), make_client("carol")
    app = launch(jacob)
    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        await pilot.press("ctrl+b")

        assert not app.query_one("#sidebar").display

    bob.send("jacob", "this chat opens first")
    carol.send("jacob", "you cannot see my row")
    again = launch(jacob)
    async with again.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: "1 unread" in str(again.query_one("#link").render()))
        assert not again.query_one("#sidebar").display  # Remembered, and the bottom bar says what the hidden list would have.

        await pilot.press("ctrl+b")

        assert again.query_one("#sidebar").display
        assert "unread" not in str(again.query_one("#link").render())


async def test_quitting_asks_once_more_while_an_agent_is_working(make_client: MakeClient, launch: Launch, agent: FakeAgent) -> None:
    jacob, bob = make_client("jacob"), make_client("bob")
    question = bob.send("jacob", "@jacob/uploader this will take a while")
    app = launch(jacob, "uploader")
    agent.finish.clear()

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: "Run" in under(app, "bob", question))
        await pilot.press("ctrl+r")
        await until(pilot, lambda: app.runs != {})
        await pilot.press("ctrl+q")
        await pilot.pause(0.1)
        assert app.return_code is None  # Still here: the first press only warned.

        await pilot.press("ctrl+q")
        await pilot.pause(0.1)

        assert app.return_code == 0


async def test_quitting_with_nothing_to_lose_does_not_ask(make_client: MakeClient, launch: Launch) -> None:
    jacob, _bob = make_client("jacob"), make_client("bob")
    app = launch(jacob)

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob")
        await pilot.press("ctrl+q")
        await pilot.pause(0.1)

        assert app.return_code == 0


async def test_the_tab_title_says_what_is_waiting_for_me(make_client: MakeClient, launch: Launch) -> None:
    jacob, bob, carol = make_client("jacob"), make_client("bob"), make_client("carol")
    app = launch(jacob, "uploader")

    async with app.run_test(size=SIZE) as pilot:
        await until(pilot, lambda: app.current == "bob" and "uploader" in app.checkouts)
        assert app.tab_title == "deskmate"

        question = bob.send("jacob", "@jacob/uploader where is the config parsed?")
        carol.send("jacob", "lunch?")
        await until(pilot, lambda: app.tab_title == "deskmate · 1 waiting · 1 unread")

        await app.run_action(f"decline({question}, 'uploader')")
        await pilot.press("ctrl+down")

        await until(pilot, lambda: app.tab_title == "deskmate")
