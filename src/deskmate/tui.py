"""The chat interface: chats on the left, the open chat on the right, and anyone's agent one "@" away."""

import contextlib
import dataclasses
import re
import shlex
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from functools import partial
from pathlib import Path
from typing import ClassVar, override
from urllib.parse import unquote, urlsplit

from pydantic import ValidationError
from textual.app import App, ComposeResult, SystemCommand
from textual.binding import Binding, BindingType
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.content import Content
from textual.markup import escape
from textual.message import Message
from textual.screen import Screen
from textual.theme import BUILTIN_THEMES
from textual.widgets import ContentSwitcher, Label, OptionList, Static
from textual.widgets.option_list import Option

from deskmate import repos
from deskmate.chat import ONLINE, Candidate, ChatLog, Entry, Request, Row, UiState, agent_prompt, candidates, chat_of, mentions, rings
from deskmate.client import POLL_WAIT, AgentCancelledError, Client, DeskmateError, Runner
from deskmate.repos import Checkout
from deskmate.widgets import CSS, ChatRow, Composer, ConfirmClone, Help, Hint, JoinChannel, PickRepo, ThreadView, one_line, thread_id
from deskmate.wire import MAX_BODY, ChannelInfo, Person, Repo, RepoRef, TeamRepo, is_channel

HISTORY = 300  # Notes loaded when the interface starts or a channel is joined.
RETRY_DELAY = 5.0
SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧"
DISCARD_WINDOW = 2.0  # Seconds in which a second Esc discards a draft.
QUIT_WINDOW = 3.0  # Seconds in which a second Ctrl+Q quits despite work that would be lost.
DEFAULT_THEME = "terminal"
HINT_SLOTS = 8
TAG_BEING_TYPED = re.compile(r"(?:^|\s)@([\w./-]*)$")

type Cloner = Callable[[str, Path], None]
type Describer = Callable[[Checkout], str]

# The terminal's own sixteen colours, so the interface follows whatever palette the terminal uses.
TERMINAL_THEME = dataclasses.replace(BUILTIN_THEMES["ansi-dark"], name=DEFAULT_THEME, primary="ansi_cyan", secondary="ansi_blue", accent="ansi_magenta")


@dataclass(frozen=True)
class Draft:
    """An agent's answer waiting for its owner to review, edit and send."""

    text: str
    entry: Entry  # The note it answers.
    repo: str  # The repo the agent worked in.
    loaded: bool  # Whether it is in the message box; False while the user's own half-typed message is there.


@dataclass(frozen=True)
class AgentRun:
    entry: Entry
    repo: str
    post: bool  # Post the answer as soon as it is ready, rather than drafting it for review.
    cancel: threading.Event
    started: float
    done: threading.Event  # Set once the agent's process is gone.


class _OnUiThread(Message):
    """Carries a call from a worker thread to the interface's own thread."""

    def __init__(self, call: Callable[[], None]) -> None:
        super().__init__()
        self.call = call


class DeskmateApp(App[None]):
    """Chats, notes, and agents that run only when their owner says so."""

    CSS = CSS
    TITLE = "deskmate"
    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("ctrl+r", "run_waiting", "run request", priority=True),
        Binding("ctrl+n", "join_channel", "join channel", priority=True),
        Binding("ctrl+b", "toggle_chats", "chat list", priority=True),
        Binding("ctrl+up,alt+up", "step_chat(-1)", "previous chat", priority=True),
        Binding("ctrl+down,alt+down", "step_chat(1)", "next chat", priority=True),
        Binding("f1", "help", "help", priority=True),
        Binding("escape", "stop_or_discard", "stop or discard"),
        Binding("ctrl+q", "quit", "quit", priority=True),
    ]

    def __init__(self, client: Client, dev: Path, runner: Runner, *, cloner: Cloner = repos.clone, describe: Describer = repos.describe, poll_wait: float = POLL_WAIT) -> None:
        self._state = UiState(read={}, theme=None, chat=None)
        state_file = client.home / "state.json"
        if state_file.exists():
            with contextlib.suppress(ValidationError):  # A file from another version only costs read marks and the theme.
                self._state = UiState.model_validate_json(state_file.read_bytes())
        themes = BUILTIN_THEMES | {DEFAULT_THEME: TERMINAL_THEME}
        self._start_theme = self._state.theme if self._state.theme in themes else DEFAULT_THEME
        # Textual picks how to honour NO_COLOR while it is being built, from the theme it has then. Tell it now which kind
        # this one is: left to its default it greys out a truecolor theme, which paints a terminal-colour theme black on black.
        # ponytail: decided once at start. Switching between the two kinds of theme under NO_COLOR needs a restart.
        super().__init__(ansi_color=True if themes[self._start_theme].ansi else None)
        self.client = client
        self.dev = dev
        self.runner = runner
        self.cloner = cloner
        self.describe = describe
        self._poll_wait = poll_wait
        self._stop_polling = threading.Event()
        self._sharing = threading.Lock()
        self._advertised: list[Repo] | None = None
        self.me = client.config.name
        self.chats = ChatLog(self.me)
        self.people: list[Person] = []
        self.channels: list[ChannelInfo] = []
        self.team: list[TeamRepo] = []  # Every repo anyone has checked out.
        self.checkouts: dict[str, Checkout] = {}  # The user's own, by repo name.
        self.prefix = ""  # The key every repo this hub shares starts with; "" until the hub has said.
        self.current = ""  # The open chat; "" until one exists.
        self.typed: dict[str, str] = {}  # Per chat, what is in the message box while another chat is open.
        self.drafts: dict[str, list[Draft]] = {}  # Per chat, answers waiting for review; the first is the one being reviewed.
        self.runs: dict[tuple[int, str], AgentRun] = {}  # By (tagging note, repo).
        self.connected = False
        self.problem = ""
        self.read = dict(self._state.read)
        self._loaded = False
        self._esc_at = 0.0
        self._frame = 0
        self._animated = False  # Whether the open chat shows an agent at work.
        self._autorun: set[int] = set()  # Notes just sent from here: their tags of the user's own agents run without asking.
        self._picks: tuple[Candidate, ...] = ()
        self._pick_span = ((0, 0), (0, 0))
        self.last_sent: dict[str, str] = {}  # Per chat, the last message the user typed and sent, for ↑ to bring back.
        self.chats_hidden = self._state.chats_hidden
        self.tab_title = ""  # What the terminal tab was last told to say.
        self._quit_at = 0.0
        self._row_widgets: dict[str, ChatRow] = {}
        self._threads: dict[str, ThreadView] = {}
        self._hints: tuple[tuple[str, str, str], ...] = ()

    # ── layout ────────────────────────────────────────────────────────────────

    @override
    def compose(self) -> ComposeResult:
        with Horizontal(id="top"):
            yield Label(" deskmate ", id="brand")
            yield Label("", id="identity", markup=False)
            yield Static("[@click=app.toggle_chats]☰ Chats[/]  [@click=app.help]? Help[/] ", id="help-link")
        with Horizontal(id="body"):
            with Vertical(id="sidebar") as sidebar:
                sidebar.border_title = "Chats"
                with VerticalScroll(id="rows"):
                    yield Static("Channels", classes="section -first", markup=False)
                    yield Vertical(id="channel-rows")
                    yield Static("[@click=app.join_channel]+ Join or create[/]", classes="action")
                    yield Static("People", classes="section", markup=False)
                    yield Vertical(id="people-rows")
                    yield Static(id="nobody", classes="nobody", markup=False)
            with Vertical(id="pane"):
                with ContentSwitcher(id="threads", initial="empty"):
                    yield Static("⠋ loading…", id="empty", markup=False)
                with Horizontal(id="status"):
                    yield Static(id="status-text")
                    yield Static(id="status-actions")
                yield OptionList(id="picker")
                with Horizontal(id="compose"):
                    yield Label("›", id="prompt")
                    yield Composer(compact=True, highlight_cursor_line=False, soft_wrap=True, placeholder="Message")
        with Horizontal(id="bottom"):
            with Horizontal(id="hints"):
                for _ in range(HINT_SLOTS):
                    yield Hint()
            yield Static("◌ connecting", id="link", markup=False)

    @override
    def get_css_variables(self) -> dict[str, str]:
        variables = super().get_css_variables()
        ansi = self.current_theme.ansi
        return variables | {
            "dm-muted": "ansi_bright_black" if ansi else variables["text-muted"],
            "dm-border": "ansi_bright_black" if ansi else variables["surface-lighten-2"],
            "dm-selected": "ansi_bright_black" if ansi else variables["surface-lighten-1"],
        }

    @override
    def get_system_commands(self, screen: Screen[object]) -> Iterable[SystemCommand]:
        yield from super().get_system_commands(screen)
        yield SystemCommand("Join or create a channel", "Start or enter a group chat", self.action_join_channel)
        yield SystemCommand("Show the chat list" if self.chats_hidden else "Hide the chat list", "Give the open chat the full width, or take it back", self.action_toggle_chats)
        if is_channel(self.current):
            yield SystemCommand(f"Pin a repo to {self.current}", "Say which repo this channel is about", self.action_pin_repo)
            if self._pinned():
                yield SystemCommand(f"Unpin the repo from {self.current}", "Make this channel about no repo in particular", self.action_unpin_repo)
            yield SystemCommand(f"Leave {self.current}", "Stop receiving this channel's notes", self.action_leave_channel)
        for row in self._rows():
            yield SystemCommand(f"Open {row.chat}", "Switch to this chat", partial(self.action_open_chat, row.chat))

    def on_mount(self) -> None:
        self.register_theme(TERMINAL_THEME)
        self.theme = self._start_theme
        self.ansi_color = None  # From here on, each theme says for itself whether it uses the terminal's colours.
        self.query_one("#picker", OptionList).can_focus = False  # Its keys arrive through the message box, which keeps the focus.
        self.query_one("#sidebar", Vertical).set_class(self.chats_hidden, "-hidden")
        self._to_terminal("\x1b[22;0t")  # Ask the terminal to remember its tab title, so it can be put back on the way out.
        self._spinner = self.set_interval(0.1, self._spin, pause=True)
        self.query_one(Composer).focus()
        self.poller = threading.Thread(target=self._poll, daemon=True, name="deskmate-poll")
        self.poller.start()
        self._refresh()

    def on_unmount(self) -> None:
        self._to_terminal("\x1b]2;\x07\x1b[23;0t")  # Clear the title, then ask for the remembered one back: a terminal that kept none shows its default.
        self._stop_polling.set()
        self.stop_agents()

    def stop_agents(self) -> None:
        """Stop every agent still working, and wait briefly so its process is gone before this one is."""
        runs = list(self.runs.values())
        for run in runs:
            run.cancel.set()
        for run in runs:
            run.done.wait(3)

    def watch_theme(self, theme: str) -> None:
        if self._loaded or theme != DEFAULT_THEME:
            self._save_state(theme=theme)

    # ── the hub and the disk, on worker threads ───────────────────────────────

    def _ui(self, call: Callable[[], None]) -> None:
        self.post_message(_OnUiThread(call))

    def on__on_ui_thread(self, message: _OnUiThread) -> None:
        if self.is_running:  # A worker can still report in while the app is closing, when the widgets it would update are gone.
            message.call()

    def _share(self, prefix: str) -> None:
        """Look under ~/dev for the team's repos and tell the hub when the list or a branch has changed."""
        with self._sharing:
            found = repos.scan(self.dev, prefix)
            adverts = [Repo(name=checkout.remote.name, key=checkout.remote.key, url=checkout.remote.url, branch=checkout.branch) for checkout in found]
            if adverts != self._advertised:
                self.client.advertise(adverts)
                self._advertised = adverts
        self._ui(partial(self._set_checkouts, prefix, found))

    def _snapshot(self, after: int | None) -> tuple[list[Person], list[ChannelInfo], list[TeamRepo], list[Entry]]:
        people, channels, team = self.client.users(), self.client.channels(), self.client.repos()
        batch = self.client.notes(tail=HISTORY) if after is None else self.client.notes(after=after, wait=self._poll_wait)
        return people, channels, team, [Entry(delivered.id, delivered.note, self.client.is_trusted(delivered.note)) for delivered in batch]

    def _poll(self) -> None:
        after: int | None = None
        prefix = ""
        while not self._stop_polling.is_set():
            try:
                prefix = prefix or self.client.info().repos
                self._share(prefix)
                people, channels, team, entries = self._snapshot(after)
            except (DeskmateError, ValidationError) as err:
                self._ui(partial(self._link_down, str(err)))
                self._stop_polling.wait(RETRY_DELAY)
                continue
            self._ui(partial(self._sync, people, channels, team, entries, after is None))
            after = max([after or 0, *(entry.id for entry in entries)])

    def _background(self, work: Callable[[], None], failed: Callable[[str], None]) -> None:
        def body() -> None:
            try:
                work()
            except (DeskmateError, ValidationError, OSError) as err:
                self._ui(partial(failed, str(err)))

        threading.Thread(target=body, daemon=True).start()

    def _report(self, chat: str, entry: Entry, repo: str, state: str) -> None:
        """Tell everyone in the chat what an agent is doing with a note. Best effort: the note itself is what matters."""
        with contextlib.suppress(DeskmateError, ValidationError):
            self.client.send(chat, state, kind="status", agent=repo, re=entry.id)

    def _link_down(self, problem: str) -> None:
        self.connected, self.problem = False, problem
        self._refresh()

    def _set_checkouts(self, prefix: str, found: list[Checkout]) -> None:
        self.prefix = prefix
        self.checkouts = {checkout.remote.name: checkout for checkout in found}
        self._refresh()

    def _sync(self, people: list[Person], channels: list[ChannelInfo], team: list[TeamRepo], entries: list[Entry], first: bool) -> None:
        self.people, self.channels, self.team, self.connected, self.problem = people, channels, team, True, ""
        fresh = self.chats.add(entries)
        touched = list(dict.fromkeys(chat_of(entry.note, self.me) for entry in fresh))
        for chat in touched:
            if view := self._threads.get(chat):
                arrived = [entry for entry in fresh if entry.note.kind == "note" and chat_of(entry.note, self.me) == chat]
                view.append(arrived, new_after=None if chat == self.current or not arrived else arrived[0].id - 1)  # Unseen: mark where it starts.
        self._loaded = True
        for entry in fresh:
            if entry.id in self._autorun:
                self._run_own_tags(entry)
        if not self.current:
            rows = self._rows()
            if rows:  # Start where something is waiting; failing that, where the user left off.
                last = self._state.chat if self._state.chat in [row.chat for row in rows] else rows[0].chat
                self.action_open_chat(next((row.chat for row in rows if row.unread), last))
        if not first:
            self._announce([entry for entry in fresh if entry.note.kind == "note" and entry.note.sender != self.me])
        self._mark_read()
        self._refresh()

    def _to_terminal(self, codes: str) -> None:
        """Send control codes that are not part of the picture, such as the tab title, in step with the drawing."""
        if self._driver is not None:
            self._driver.write(codes)
            self._driver.flush()

    def _announce(self, incoming: list[Entry]) -> None:
        for entry in incoming[-3:]:
            note = entry.note
            tagged = [repo for owner, repo in mentions(note.body) if owner == self.me] if entry.trusted and note.agent is None else []
            where = f" in {note.to}" if is_channel(note.to) else ""
            if tagged:
                self.notify(one_line(note.body, 120), title=f"{note.sender} tagged your {tagged[0]} agent{where}", markup=False)
            elif chat_of(note, self.me) != self.current:
                self.notify(one_line(note.body, 120) if entry.trusted else "a note failed its signature check", title=f"{note.sender}{where}", markup=False)
        if any(rings(entry, self.me) for entry in incoming):  # Channel chatter shows as unread without a sound.
            self.bell()

    # ── state the widgets show ────────────────────────────────────────────────

    def _now(self) -> float:
        return self.client.now()

    def _rows(self) -> list[Row]:
        return self.chats.rows(self.channels, [person.name for person in self.people], self.read)

    def _today(self) -> date:
        return datetime.fromtimestamp(self._now(), tz=UTC).astimezone().date()

    def _here(self, name: str) -> bool:
        return any(person.name == name and self._now() - person.seen <= ONLINE for person in self.people)

    def _pinned(self) -> RepoRef | None:
        """The repo the open channel is about, if it is a channel and has one."""
        return next((channel.repo for channel in self.channels if channel.name == self.current), None)

    def _mark_read(self) -> None:
        entries = self.chats.entries(self.current)
        newest = entries[-1].id if entries else 0
        if self.read.get(self.current, 0) < newest or self._state.chat != self.current:
            self.read[self.current] = max(newest, self.read.get(self.current, 0))
            self._save_state()

    def _save_state(self, theme: str | None = None) -> None:
        self._state = UiState(read=dict(self.read), theme=theme or self._state.theme, chat=self.current or self._state.chat, chats_hidden=self.chats_hidden)
        (self.client.home / "state.json").write_text(self._state.model_dump_json(indent=1))

    def _refresh(self) -> None:
        self._refresh_sidebar()
        self._refresh_pane()
        self._refresh_bars()
        self._refresh_status()
        self._refresh_title()

    def _elsewhere(self) -> tuple[int, int]:
        """How many requests are waiting for the user's agents anywhere, and how many notes are unread."""
        rows = self._rows()
        return sum(len(self.chats.waiting_for_me(row.chat, self._now())) for row in rows), sum(row.unread for row in rows)

    def _refresh_title(self) -> None:
        """Keep the terminal tab saying what needs the user, so it shows while they are in another tab."""
        waiting, unread = self._elsewhere()
        title = " · ".join(["deskmate", *([f"{waiting} waiting"] if waiting else []), *([f"{unread} unread"] if unread else [])])
        if title != self.tab_title:
            self.tab_title = title
            self._to_terminal(f"\x1b]2;{title}\x07")

    def _refresh_sidebar(self) -> None:
        """Bring the chat list in line with what is known. Rows are made once and updated in place, never rebuilt."""
        rows = self._rows()
        wanted = [row.chat for row in rows]
        for chat in [chat for chat in self._row_widgets if chat not in wanted]:
            self._row_widgets.pop(chat).remove()
        added = [chat for chat in wanted if chat not in self._row_widgets]
        for chat in added:
            widget = self._row_widgets[chat] = ChatRow(chat)
            self.query_one("#channel-rows" if is_channel(chat) else "#people-rows", Vertical).mount(widget)
        if added:
            self.call_after_refresh(self._sort_rows)
        alone = self._loaded and all(is_channel(chat) for chat in wanted)
        self.query_one("#nobody", Static).update("nobody else yet" if alone else "")
        working = {chat_of(run.entry.note, self.me) for run in self.runs.values()}
        spinner = SPINNER[self._frame % len(SPINNER)]
        for row in rows:
            asked = "▶" if self.chats.waiting_for_me(row.chat, self._now()) else ""
            mark = spinner if row.chat in working else ("✎" if self.drafts.get(row.chat) else asked)
            self._row_widgets[row.chat].show(current=row.chat == self.current, unread=row.unread, mark=mark, here=None if is_channel(row.chat) else self._here(row.chat))

    def _sort_rows(self) -> None:
        for group in ("#channel-rows", "#people-rows"):
            self.query_one(group, Vertical).sort_children(key=lambda widget: widget.chat if isinstance(widget, ChatRow) else "")

    def _refresh_pane(self) -> None:
        config = self.client.config
        home = str(Path.home())
        where = str(self.dev).replace(home, "~", 1) if str(self.dev).startswith(home) else str(self.dev)
        self.query_one("#identity", Label).update(f" {self.me} on {urlsplit(config.hub).netloc} · {config.agent} · {len(self.checkouts)} repos in {where}")
        pane = self.query_one("#pane", Vertical)
        if not self.current:
            pane.border_title = "deskmate"
            pane.border_subtitle = ""
            if self._loaded:
                self.query_one("#empty", Static).update("Nobody else has joined this hub yet.\nShare the install line with a teammate, or press Ctrl+N to start a channel.")
            return
        info = next((channel for channel in self.channels if channel.name == self.current), None)
        title = self.current
        if info and info.repo:
            have = sum(1 for member in info.members if any(repo.user == member and repo.key == info.repo.key for repo in self.team))
            title += f" · {info.repo.name} ({have} of {len(info.members)} have it)"
        pane.border_title = f"{title} · {', '.join(info.members)}" if info else title
        if info and self.me in info.members:
            pin = f"[@click=app.unpin_repo]◆ Unpin {info.repo.name}[/]" if info.repo else "[@click=app.pin_repo]◆ Pin a repo[/]"
            pane.border_subtitle = f"{pin} · [@click=app.leave_channel]× Leave[/]"
        else:
            pane.border_subtitle = ""
        self.query_one(Composer).placeholder = f"Message {self.current} · @ tags an agent"

    def _bar(self, requests: list[Request]) -> str:
        """The lines under a note that tags agents: for the user's own, what they can do; for a teammate's, where it stands."""
        lines: list[str] = []
        spin = f"[$primary]{SPINNER[self._frame % len(SPINNER)]}[/]"
        for request in requests:
            note_id, repo, asker = request.entry.id, request.repo, request.entry.note.sender
            mine = request.owner == self.me
            who = f"your {repo} agent" if mine else f"{request.owner}'s {repo} agent"
            run = self.runs.get((note_id, repo)) if mine else None
            drafted = mine and any(draft.entry.id == note_id and draft.repo == repo for draft in self.drafts.get(chat_of(request.entry.note, self.me), []))
            if request.state == "answered":
                continue
            if drafted:
                lines.append(f"[$warning]✎[/] {who} has drafted an answer · it is in the message box for you to review")
                continue
            if run:
                self._animated = True
                on = f" on {escape(request.detail)}" if request.state == "working" and request.detail else ""
                lines.append(f"{spin} {who} is working{on} · {int(time.monotonic() - run.started)}s · [@click=app.stop_run({note_id}, '{repo}')]■ Stop[/]")
            elif mine and repo not in self.checkouts:
                lines.append(f"[$warning]?[/] you have no checkout of {repo} · [@click=app.clone('{repo}')]⇣ Clone it[/]")
            elif mine:
                before = {"declined": "you declined · ", "failed": "it failed · ", "stopped": "stopped · ", "working": "interrupted · "}.get(request.state, "")
                decline = "" if asker == self.me or request.state == "declined" else f" · [@click=app.decline({note_id}, '{repo}')]× Decline[/]"
                run_it = f"[@click=app.run_request({note_id}, '{repo}', False)]▶ Run and review[/] · [@click=app.run_request({note_id}, '{repo}', True)]▶▶ Run and post[/]"
                lines.append(f"[$warning]◆[/] {before}{who} · {run_it}{decline}")
            elif request.state == "working":
                self._animated = True
                lines.append(f"{spin} {who} is working{f' on {escape(request.detail)}' if request.detail else ''}")
            elif request.state == "waiting":
                lines.append(self._waiting_on(request.owner, repo))
            else:
                lines.append({"declined": f"× {request.owner} declined", "failed": f"✗ {who} failed", "stopped": f"■ {who} was stopped"}[request.state])
        return "\n".join(lines)

    def _waiting_on(self, owner: str, repo: str) -> str:
        if all(person.name != owner for person in self.people):
            return f"[$warning]?[/] nobody named {owner} has joined"
        if all(theirs.user != owner or theirs.name != repo for theirs in self.team):
            return f"[$warning]?[/] {owner} has no checkout of {repo}"
        return f"◌ waiting for {owner} to approve{'' if self._here(owner) else ' · they are away'}"

    def _refresh_bars(self) -> None:
        """Redraw the status lines of the open chat's tagging notes, and note whether any of them is moving."""
        self._animated = False
        view = self._threads.get(self.current)
        for note_id, message in view.tagging.items() if view else ():
            entry = self.chats.find(note_id)
            message.set_bar(self._bar(self.chats.requests(entry, self._now())) if entry else "")
        if self.runs or self._animated:
            self._spinner.resume()
        else:
            self._spinner.pause()

    def _refresh_status(self) -> None:
        status = self.query_one("#status", Horizontal)
        drafts = self.drafts.get(self.current, [])
        draft = drafts[0] if drafts else None
        pinned = self._pinned()
        waiting = self.chats.waiting_for_me(self.current, self._now()) if self.current else []
        running = [key for key, run in self.runs.items() if chat_of(run.entry.note, self.me) == self.current]
        hints: list[tuple[str, str, str]] = []
        text = actions = ""
        discard = "[@click=app.discard_draft]× Discard[/]"
        more = f" · {len(drafts) - 1} more" if len(drafts) > 1 else ""
        reviewing = bool(draft and draft.loaded)
        self.query_one("#compose", Horizontal).set_class(reviewing, "-draft")  # More room, and a different prompt: Enter now sends the agent's words.
        self.query_one("#prompt", Label).update("✎" if reviewing else "›")
        if draft and draft.loaded:
            text = f"[$warning]✎[/] {draft.repo} draft for {draft.entry.note.sender} · Enter sends{more}"
            actions = discard
            hints += [("Enter", "send draft", "app.send"), ("Esc Esc", "discard", "app.discard_draft")]
        elif draft:
            text = f"[$primary]✎[/] {draft.repo} draft for {draft.entry.note.sender} is ready{more}"
            actions = f"[@click=app.load_draft]Load it[/] · {discard}"
        elif pinned and self._loaded and pinned.name not in self.checkouts:
            text = f"[$warning]◆[/] This channel is about {pinned.name}, which you have no checkout of"
            actions = f"[@click=app.clone('{pinned.name}')]⇣ Clone it[/]"
        if waiting:
            hints.append(("^R", "run request", "app.run_waiting"))
        if running:
            hints.append(("Esc", "stop my agent", "app.stop_or_discard"))
        if not reviewing:
            hints.append(("Enter", "send", "app.send"))
        self.query_one("#status-text", Static).update(text)
        self.query_one("#status-actions", Static).update(actions)
        status.set_class(bool(text), "-on")
        hints += [
            ("@", "tag an agent", ""),
            ("^↓", "next chat", "app.step_chat(1)"),
            ("^B", "chat list", "app.toggle_chats"),
            ("^N", "join channel", "app.join_channel"),
            ("^P", "commands", "app.command_palette"),
        ]
        hints.append(("^Q", "quit", "app.quit"))
        if self._picks:  # The tag list is open: its keys are the ones that matter.
            hints = [("↑↓", "move", ""), ("Enter", "take", ""), ("Esc", "close", "")]
        state = "● connected " if self.connected else (f"◌ {one_line(self.problem, 40)} · retrying " if self.problem else "◌ connecting ")
        asks, unread = self._elsewhere()
        if self.chats_hidden and (asks or unread):  # With the list hidden, this is where the user learns something is waiting.
            state = " · ".join([*([f"▶ {asks} waiting"] if asks else []), *([f"{unread} unread"] if unread else []), state])
        link = self.query_one("#link", Static)
        link.update(state)
        link.set_class(bool(self.problem), "-down")
        room = self.size.width - len(state) - 3  # The state on the right always shows; hints give way one whole hint at a time.
        fitting: list[tuple[str, str, str]] = []
        for hint in hints:
            room -= len(hint[0]) + len(hint[1]) + 3
            if room < 0:
                break
            fitting.append(hint)
        if tuple(fitting) != self._hints:
            self._hints = tuple(fitting)
            for index, slot in enumerate(self.query(Hint)):
                slot.show(fitting[index] if index < len(fitting) else None)

    def on_resize(self) -> None:
        self._refresh_status()

    def _spin(self) -> None:
        self._frame += 1
        self._refresh_sidebar()
        self._refresh_bars()

    # ── the tag list ──────────────────────────────────────────────────────────

    def on_text_area_changed(self) -> None:
        self._refresh_picks()

    def on_text_area_selection_changed(self) -> None:
        self._refresh_picks()

    def _refresh_picks(self) -> None:
        """Open the list of agents while the user is typing a tag, narrowed to what they have typed of it."""
        composer = self.query_one(Composer)
        row, column = composer.cursor_location
        typed = TAG_BEING_TYPED.search(composer.document.get_line(row)[:column])
        pinned = self._pinned()
        partner = None if is_channel(self.current) else self.current or None
        found = candidates(str(typed.group(1)), self.team, self.me, pinned.name if pinned else None, partner) if typed else None
        self._picks = found.rows if found else ()
        self._pick_span = ((row, column - len(str(typed.group(1))) - 1), (row, column)) if typed else ((0, 0), (0, 0))
        picker = self.query_one("#picker", OptionList)
        picker.clear_options()
        where = str(self.dev).replace(str(Path.home()), "~", 1)
        for pick in self._picks:
            label = Content.assemble((f"⇣ clone {pick.repo} into {where}", "$dm-muted")) if pick.clone else Content.assemble(pick.tag, (f"  {pick.branch}", "$dm-muted"))
            picker.add_option(Option(label))
        if found and found.more:
            picker.add_option(Option(f"{found.more} more · keep typing", disabled=True))
        picker.highlighted = 0 if self._picks else None
        picker.set_class(bool(self._picks), "-on")
        composer.completing = bool(self._picks)
        self._refresh_status()

    def _close_picks(self) -> None:
        self._picks = ()
        self.query_one("#picker", OptionList).set_class(False, "-on")
        self.query_one(Composer).completing = False
        self._refresh_status()

    def _take_pick(self, index: int | None) -> None:
        if index is None or index >= len(self._picks):
            return
        pick = self._picks[index]
        composer = self.query_one(Composer)
        start, end = self._pick_span
        self._close_picks()
        if pick.clone:
            composer.replace("", start, end)
            self.action_clone(pick.repo)
        else:
            composer.replace(f"{pick.tag} ", start, end)

    def on_composer_list_key(self, message: Composer.ListKey) -> None:
        picker = self.query_one("#picker", OptionList)
        if message.key == "escape":
            self._close_picks()
        elif message.key == "up":
            picker.action_cursor_up()
        elif message.key == "down":
            picker.action_cursor_down()
        else:
            self._take_pick(picker.highlighted)

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if event.option_list.id == "picker":
            self._take_pick(event.option_index)
            self.query_one(Composer).focus()

    # ── actions: every key, and everything clickable ──────────────────────────

    def action_open_chat(self, chat: str) -> None:
        composer = self.query_one(Composer)
        if self.current:
            self.typed[self.current] = composer.text
        if self.current != chat and (left := self._threads.get(self.current)):
            left.clear_new()  # Its "new" line has been seen.
        self.current = chat
        switcher = self.query_one("#threads", ContentSwitcher)
        if chat not in self._threads:
            view = self._threads[chat] = ThreadView(chat, self.chats, self._today)
            view.append(self.chats.entries(chat)[-HISTORY:], new_after=self.read.get(chat))  # A chat never opened has no "left off".
            switcher.add_content(view, set_current=True)
        else:
            switcher.current = thread_id(chat)
        composer.set_text(self.typed.get(chat, ""))
        composer.focus()
        self._mark_read()
        self._refresh()

    def action_step_chat(self, step: int) -> None:
        chats = [row.chat for row in self._rows()]
        if chats:
            self.action_open_chat(chats[(chats.index(self.current) + step) % len(chats)] if self.current in chats else chats[0])

    def action_help(self) -> None:
        if not isinstance(self.screen, Help):
            self.push_screen(Help())

    def _failed(self, what: str, problem: str) -> None:
        self.notify(problem, title=what, severity="error", markup=False)

    def action_join_channel(self) -> None:
        if isinstance(self.screen, JoinChannel):
            return
        others = [channel for channel in self.channels if self.me not in channel.members]
        self.push_screen(JoinChannel(others), self._join)

    def _join(self, channel: str | None) -> None:
        if not channel:
            return

        def work() -> None:
            self.client.join_channel(channel)
            people, channels, team, entries = self._snapshot(None)  # A channel's earlier notes are older than the poll cursor, so load them now.
            self._ui(partial(self._joined, channel, people, channels, team, entries))

        self._background(work, partial(self._failed, f"could not join {channel}"))

    def _joined(self, channel: str, people: list[Person], channels: list[ChannelInfo], team: list[TeamRepo], entries: list[Entry]) -> None:
        self._sync(people, channels, team, entries, True)
        self.action_open_chat(channel)

    def action_leave_channel(self) -> None:
        channel = self.current
        if not is_channel(channel):
            return

        def work() -> None:
            self.client.leave_channel(channel)
            channels = self.client.channels()
            self._ui(partial(self._left, channel, channels))

        self._background(work, partial(self._failed, f"could not leave {channel}"))

    def _left(self, channel: str, channels: list[ChannelInfo]) -> None:
        self.channels = channels
        self.chats.forget(channel)
        self.typed.pop(channel, None)
        self.drafts.pop(channel, None)
        if view := self._threads.pop(channel, None):
            view.remove()
        self.notify(f"You left {channel}.", markup=False)
        if self.current == channel:
            self.current = ""
            self.query_one("#threads", ContentSwitcher).current = "empty"
            if rows := self._rows():
                self.action_open_chat(rows[0].chat)
        self._refresh()

    def _set_channels(self, channels: list[ChannelInfo]) -> None:
        self.channels = channels
        self._refresh()

    def action_pin_repo(self) -> None:
        channel = self.current
        if not is_channel(channel) or isinstance(self.screen, PickRepo):
            return
        if not self.checkouts:
            self.notify(f"You have no team repos under {self.dev} to pin.", markup=False)
            return

        def pin(name: str | None) -> None:
            checkout = self.checkouts.get(name or "")
            if checkout:
                ref = RepoRef(name=checkout.remote.name, key=checkout.remote.key, url=checkout.remote.url)
                self._background(lambda: self._ui(partial(self._set_channels, [*self._others(channel), self.client.pin(channel, ref)])), partial(self._failed, f"could not pin a repo to {channel}"))

        self.push_screen(PickRepo(f"Which repo is {channel} about?", sorted(self.checkouts)), pin)

    def action_unpin_repo(self) -> None:
        channel = self.current
        if is_channel(channel):
            self._background(lambda: self._ui(partial(self._set_channels, [*self._others(channel), self.client.unpin(channel)])), partial(self._failed, f"could not unpin the repo from {channel}"))

    def _others(self, channel: str) -> list[ChannelInfo]:
        return [other for other in self.channels if other.name != channel]

    def action_clone(self, repo: str) -> None:
        """Offer to clone a repo the user lacks into ~/dev, showing where it comes from before anything is fetched."""
        pinned = self._pinned()
        known: list[RepoRef] = [*self.team, *([pinned] if pinned else [])]
        ref = next((candidate for candidate in known if candidate.name == repo), None)
        if ref is None or repo in self.checkouts:
            self.notify(f"You already have {repo}." if repo in self.checkouts else f"Nobody on this hub has {repo}, so there is nowhere to clone it from.", markup=False)
            return
        destination = self.dev / unquote(ref.url.rstrip("/").rsplit("/", 1)[-1])

        def clone(agreed: bool | None) -> None:
            if not agreed:
                return
            self.notify(f"Cloning {repo}…", markup=False)

            def work() -> None:
                self.cloner(ref.url, destination)
                self._share(self.prefix)
                self._ui(partial(self.notify, f"Cloned {repo} into {destination}. Your {repo} agent can be tagged now.", markup=False))

            self._background(work, partial(self._failed, f"could not clone {repo}"))

        self.push_screen(ConfirmClone(ref.url, destination), clone)

    def on_composer_submitted(self, message: Composer.Submitted) -> None:
        chat, text = self.current, message.text.strip()
        if not chat or not text:
            return
        drafts = self.drafts.get(chat, [])
        answering = drafts[0] if drafts and drafts[0].loaded else None
        self.query_one(Composer).set_text("")
        self.typed[chat] = ""
        if answering:
            drafts.pop(0)
        else:
            self.last_sent[chat] = text
        self._offer_draft(chat)
        self._refresh()

        def work() -> None:
            if answering:
                self.client.send(chat, text[:MAX_BODY], agent=answering.repo, re=answering.entry.id)
            else:
                self._ui(partial(self._sent, self.client.send(chat, text[:MAX_BODY])))

        self._background(work, partial(self._send_failed, chat, text, answering))

    def action_send(self) -> None:
        """What Enter does in the message box, for the hint in the bottom bar to do on a click."""
        self.on_composer_submitted(Composer.Submitted(self.query_one(Composer).text))

    def on_composer_recall(self) -> None:
        if last := self.last_sent.get(self.current):
            self.query_one(Composer).set_text(last)

    def action_toggle_chats(self) -> None:
        self.chats_hidden = not self.chats_hidden
        self.query_one("#sidebar", Vertical).set_class(self.chats_hidden, "-hidden")
        self._save_state()
        self._refresh()

    @override
    async def action_quit(self) -> None:
        """Quit, but ask once more first when that would stop an agent or throw a draft away."""
        working, unsent = len(self.runs), sum(len(drafts) for drafts in self.drafts.values())
        if (working or unsent) and time.monotonic() - self._quit_at > QUIT_WINDOW:
            self._quit_at = time.monotonic()
            losing = [*([f"{working} agent{'s' if working > 1 else ''} still working"] if working else []), *([f"{unsent} draft{'s' if unsent > 1 else ''} not sent"] if unsent else [])]
            self.notify(f"{' and '.join(losing)}. Ctrl+Q again quits: agents are stopped and drafts are lost.", timeout=QUIT_WINDOW, severity="warning", markup=False)
            return
        await super().action_quit()

    def _sent(self, note_id: int) -> None:
        """A note typed here has reached the hub. Its tags of the user's own agents run without asking, whichever of the two arrives first."""
        self._autorun.add(note_id)
        if entry := self.chats.find(note_id):
            self._run_own_tags(entry)

    def _run_own_tags(self, entry: Entry) -> None:
        self._autorun.discard(entry.id)
        if entry.note.sender != self.me:
            return
        for request in self.chats.requests(entry, self._now()):
            if request.owner == self.me and request.state == "waiting" and request.repo in self.checkouts:
                self._start_run(entry, request.repo, post=True)

    def _send_failed(self, chat: str, text: str, answering: Draft | None, problem: str) -> None:
        """Put an unsent message back where it was, so nothing the user or their agent wrote is lost."""
        if answering:
            self.drafts.setdefault(chat, []).insert(0, dataclasses.replace(answering, text=text))
        elif not self.typed.get(chat) and not (chat == self.current and self.query_one(Composer).text):
            self.typed[chat] = text
            if chat == self.current:
                self.query_one(Composer).set_text(text)
        self._failed(f"not sent to {chat}", problem)
        self._refresh()

    def action_run_waiting(self) -> None:
        waiting = self.chats.waiting_for_me(self.current, self._now()) if self.current else []
        if waiting:
            self._start_run(waiting[0].entry, waiting[0].repo, post=False)
        else:
            self.notify("Nothing is waiting for your agents here. Type @ to tag one.", markup=False)

    def action_run_request(self, note_id: int, repo: str, post: bool) -> None:
        entry = self.chats.find(note_id)
        if entry and any(request.owner == self.me and request.repo == repo for request in self.chats.requests(entry, self._now())):
            self._start_run(entry, repo, post=post)

    def action_stop_run(self, note_id: int, repo: str) -> None:
        if run := self.runs.get((note_id, repo)):
            run.cancel.set()

    def action_decline(self, note_id: int, repo: str) -> None:
        if entry := self.chats.find(note_id):
            chat = chat_of(entry.note, self.me)
            self._background(lambda: self._report(chat, entry, repo, "declined"), partial(self._failed, "could not decline"))

    def _start_run(self, entry: Entry, repo: str, *, post: bool) -> None:
        checkout = self.checkouts.get(repo)
        key = (entry.id, repo)
        if key in self.runs:
            return
        if checkout is None:
            self._failed(f"your {repo} agent", f"there is no checkout of {repo} under {self.dev}")
            return
        try:
            argv = [*shlex.split(self.client.config.agent), agent_prompt(entry, self.me, repo, self.chats.earlier(entry), review=not post)]
        except ValueError as err:
            self._failed("agent command", f'cannot read "agent" in config.json: {err}')
            return
        run = AgentRun(entry, repo, post, threading.Event(), time.monotonic(), threading.Event())
        self.runs[key] = run
        chat = chat_of(entry.note, self.me)

        def work() -> None:
            try:
                self._report(chat, entry, repo, f"working\n{self.describe(checkout)}")
                text = self.runner(argv, checkout.path, run.cancel)
            except AgentCancelledError:
                self._report(chat, entry, repo, "stopped")
                self._ui(partial(self._run_ended, key, run, "", "stopped"))
            except DeskmateError as err:
                self._report(chat, entry, repo, "failed")  # Only the fact: what the agent printed on the way down may not be fit to share.
                self._ui(partial(self._run_ended, key, run, "", str(err)))
            else:
                if not text:
                    self._report(chat, entry, repo, "failed")
                self._ui(partial(self._run_ended, key, run, text, "" if text else "the agent returned nothing"))
            finally:
                run.done.set()

        threading.Thread(target=work, daemon=True, name="deskmate-agent").start()
        self._refresh()

    def _run_ended(self, key: tuple[int, str], run: AgentRun, text: str, problem: str) -> None:
        if self.runs.get(key) is run:
            del self.runs[key]
        chat = chat_of(run.entry.note, self.me)
        draft = Draft(text[:MAX_BODY], run.entry, run.repo, loaded=False)
        if problem == "stopped":
            self.notify(f"Stopped your {run.repo} agent.", markup=False)
        elif problem:
            self._failed(f"your {run.repo} agent", problem)
        elif run.post:

            def post() -> None:
                self.client.send(chat, draft.text, agent=draft.repo, re=draft.entry.id)

            self._background(post, partial(self._post_failed, chat, draft))
        else:
            self._queue_draft(chat, draft)
        self._refresh()

    def _post_failed(self, chat: str, draft: Draft, problem: str) -> None:
        """An answer that could not be posted is kept as a draft, so the agent's work is not lost."""
        self._failed(f"your {draft.repo} agent's answer was not posted; it is kept as a draft", problem)
        self._queue_draft(chat, draft)
        self._refresh()

    def _queue_draft(self, chat: str, draft: Draft) -> None:
        self.drafts.setdefault(chat, []).append(draft)
        self._offer_draft(chat)
        if chat != self.current:
            self.notify(f"Your {draft.repo} agent's draft is ready to review.", title=chat, markup=False)
        self.bell()

    def _offer_draft(self, chat: str) -> None:
        """Put the next waiting draft into the chat's message box, unless the user has something of their own typed there."""
        drafts = self.drafts.get(chat, [])
        if not drafts:
            self.drafts.pop(chat, None)
            return
        box_is_empty = not (self.query_one(Composer).text if chat == self.current else self.typed.get(chat, ""))
        if not drafts[0].loaded and box_is_empty:
            self._load_draft(chat)

    def _load_draft(self, chat: str) -> None:
        drafts = self.drafts[chat]
        drafts[0] = dataclasses.replace(drafts[0], loaded=True)
        self.typed[chat] = drafts[0].text
        if chat == self.current:
            self.query_one(Composer).set_text(drafts[0].text)

    def action_load_draft(self) -> None:
        if self.drafts.get(self.current):
            self._load_draft(self.current)
            self._refresh()

    def action_discard_draft(self) -> None:
        chat = self.current
        drafts = self.drafts.get(chat, [])
        if not drafts:
            return
        draft = drafts.pop(0)
        if draft.loaded:
            self.typed[chat] = ""
            self.query_one(Composer).set_text("")
        self._background(lambda: self._report(chat, draft.entry, draft.repo, "declined"), partial(self._failed, "could not tell the chat"))
        self._offer_draft(chat)
        self._refresh()

    def action_stop_or_discard(self) -> None:
        """Esc: stop the agents working in this chat, or, pressed twice, discard the draft being reviewed."""
        running = [run for run in self.runs.values() if chat_of(run.entry.note, self.me) == self.current]
        if running:
            for run in running:
                run.cancel.set()
        elif self.drafts.get(self.current):
            if time.monotonic() - self._esc_at <= DISCARD_WINDOW:
                self.action_discard_draft()
            else:
                self._esc_at = time.monotonic()
                self.notify("Press Esc again to discard the draft.", timeout=DISCARD_WINDOW, markup=False)
