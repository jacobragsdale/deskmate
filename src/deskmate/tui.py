"""The chat interface: chats on the left, the open chat on the right, and your agent one click away."""

import contextlib
import dataclasses
import shlex
import threading
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from functools import partial
from pathlib import Path
from typing import ClassVar, override
from urllib.parse import urlsplit

from pydantic import ValidationError
from textual import events
from textual.app import App, ComposeResult, SystemCommand
from textual.binding import Binding, BindingType
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.content import Content
from textual.message import Message
from textual.screen import ModalScreen, Screen
from textual.theme import BUILTIN_THEMES
from textual.widget import Widget
from textual.widgets import ContentSwitcher, Input, Label, Markdown, OptionList, Static, TextArea
from textual.widgets.option_list import Option

from deskmate.chat import ChatLog, Entry, Row, UiState, agent_prompt, chat_of, continues, is_request
from deskmate.client import POLL_WAIT, AgentCancelledError, Client, DeskmateError, Runner
from deskmate.wire import MAX_BODY, ChannelInfo, is_channel

HISTORY = 300  # Notes loaded when the interface starts or a channel is joined.
RETRY_DELAY = 5.0
SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧"
DISCARD_WINDOW = 2.0  # Seconds in which a second Esc discards a draft.
NAME_COLOURS = ("$accent", "$secondary", "$success", "$warning", "$primary")
DEFAULT_THEME = "terminal"
HINT_SLOTS = 7

# The terminal's own sixteen colours, so the interface follows whatever palette the terminal uses.
TERMINAL_THEME = dataclasses.replace(BUILTIN_THEMES["ansi-dark"], name=DEFAULT_THEME, primary="ansi_cyan", secondary="ansi_blue", accent="ansi_magenta")

KEYS = (
    ("Enter", "send the message, or the draft you are reviewing"),
    ("Ctrl+J", "new line in the message"),
    ("Ctrl+R", "run your agent on the newest note from someone else"),
    ("Esc", "stop your agent; press twice to discard a draft"),
    ("Ctrl+↑ / Ctrl+↓", "previous or next chat"),
    ("Ctrl+N", "join or create a channel"),
    ("Ctrl+P", "commands: open a chat, leave a channel, change theme"),
    ("Ctrl+C", "copy the text you selected with the mouse"),
    ("F1", "this help"),
    ("Ctrl+Q", "quit"),
)

CSS = """
Screen { layout: vertical; }
#top { height: 1; }
#brand { width: auto; color: $primary; text-style: bold; }
#identity { width: 1fr; color: $dm-muted; text-wrap: nowrap; text-overflow: ellipsis; }
#help-link { width: auto; color: $dm-muted; }
#body { height: 1fr; }

#sidebar { width: 26; border: round $dm-border; border-title-color: $dm-muted; }
#rows { height: 1fr; }
#channel-rows, #people-rows { height: auto; }
.section { height: 1; margin-top: 1; padding: 0 2; color: $dm-muted; text-style: bold; }
.section.-first { margin-top: 0; }
.nobody { height: 1; padding: 0 2; color: $dm-muted; }
ChatRow { height: 1; }
ChatRow:hover { color: $primary; }
ChatRow.-unread { text-style: bold; }
ChatRow.-current { color: $foreground; background: $dm-selected; text-style: bold; }
.action { height: 1; padding: 0 2; color: $dm-muted; }

#pane { width: 1fr; padding: 0 1; border: round $primary; border-title-color: $primary; border-title-style: bold; border-subtitle-color: $dm-muted; }
#threads { height: 1fr; }
#empty { height: 1fr; color: $dm-muted; content-align: center middle; text-align: center; }
ThreadView { height: 1fr; }
.none-yet { height: auto; margin-top: 1; color: $dm-muted; text-align: center; }
.day { height: 1; margin-top: 1; color: $dm-muted; text-align: center; }
MessageView { height: auto; margin-top: 1; }
MessageView.-joined { margin-top: 0; }
MessageView .head { height: 1; }
MessageView .who { width: 1fr; text-wrap: nowrap; text-overflow: ellipsis; }
MessageView .run { width: auto; margin-left: 2; visibility: hidden; color: $dm-muted; }
MessageView.-over .run { visibility: visible; }
MessageView.-newest .run { visibility: visible; color: $primary; }
MessageView .quote { height: 1; color: $dm-muted; text-wrap: nowrap; text-overflow: ellipsis; }
MessageView .text { height: auto; }
MessageView .untrusted { height: auto; color: $error; }
MessageView Markdown { margin: 0; padding: 0; background: transparent; }
MessageView MarkdownFence { margin: 0 0 1 0; padding: 0 1; border-left: heavy $dm-border; color: $foreground; background: transparent; }
MessageView MarkdownFence > Label { padding: 0; }
MessageView Markdown > *:last-child { margin-bottom: 0; }

#status { height: 1; margin-top: 1; display: none; }
#status.-on { display: block; }
#status-text { width: 1fr; color: $dm-muted; text-wrap: nowrap; text-overflow: ellipsis; }
#status-actions { width: auto; margin-left: 2; link-color: $primary; }
#compose { height: auto; border-top: solid $dm-border; }
#prompt { width: 2; color: $primary; text-style: bold; }
Composer { height: auto; max-height: 8; border: none; padding: 0; background: transparent; }
Composer:focus { border: none; }

#bottom { height: 1; }
#hints { width: 1fr; height: 1; padding-left: 1; overflow: hidden; }
Hint { width: auto; margin-right: 2; color: $dm-muted; text-wrap: nowrap; display: none; }
Hint.-on { display: block; }
Hint:hover { color: $foreground; }
#link { width: auto; margin-left: 2; color: $dm-muted; }
#link.-down { color: $warning; }

#rows, ThreadView {
    scrollbar-size-vertical: 1; scrollbar-color: $dm-border; scrollbar-color-hover: $primary; scrollbar-color-active: $primary;
    scrollbar-background: $background; scrollbar-background-hover: $background; scrollbar-background-active: $background;
}
Static, Label { link-style: none; link-color: $dm-muted; link-background: transparent; link-color-hover: $primary; link-style-hover: bold; link-background-hover: transparent; }
MessageView.-newest .run { link-color: $primary; }

ModalScreen { align: center middle; }
.dialog { width: 60; max-width: 90%; height: auto; max-height: 90%; padding: 1 2; border: round $primary; border-title-color: $primary; border-title-style: bold; border-subtitle-color: $dm-muted; background: $surface; }
.dialog Input { border: none; height: 1; padding: 0; margin-bottom: 1; background: transparent; }
.dialog Input:focus { border: none; }
.dialog OptionList { height: auto; max-height: 10; border: none; padding: 0; margin-bottom: 1; background: transparent; }
.dialog .hint { width: 100%; height: auto; color: $dm-muted; }
.dialog .key { width: 18; color: $primary; text-style: bold; }
.dialog .does { width: 1fr; }
.dialog .line { height: auto; }
"""


@dataclass(frozen=True)
class Draft:
    """An agent's answer waiting for its owner to review, edit and send."""

    text: str
    entry: Entry  # The note it answers.
    loaded: bool  # Whether it is in the message box; False while the user's own half-typed message is there.


@dataclass(frozen=True)
class AgentRun:
    entry: Entry
    cancel: threading.Event
    started: float
    done: threading.Event  # Set once the agent's process is gone.


class _OnUiThread(Message):
    """Carries a call from a worker thread to the interface's own thread."""

    def __init__(self, call: Callable[[], None]) -> None:
        super().__init__()
        self.call = call


def _colour_of(name: str) -> str:
    return NAME_COLOURS[sum(name.encode()) % len(NAME_COLOURS)]


def _one_line(text: str, width: int = 60) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= width else flat[: width - 1] + "…"


def _thread_id(chat: str) -> str:
    return f"channel-{chat[1:]}" if is_channel(chat) else f"person-{chat}"


class Hint(Static):
    """One slot of the bottom bar: a key and what it does. Clicking it does what the key does."""

    def __init__(self) -> None:
        super().__init__()
        self._action = ""

    def show(self, hint: tuple[str, str, str] | None) -> None:
        self.set_class(hint is not None, "-on")
        if hint:
            key, does, self._action = hint
            self.update(f"[b $primary]{key}[/] {does}")

    async def on_click(self) -> None:
        if self._action:
            await self.app.run_action(self._action)


class ChatRow(Widget):
    """One chat in the list: a marker when it is open, its name, and what is waiting in it. Clicking it opens the chat."""

    def __init__(self, chat: str) -> None:
        super().__init__()
        self.chat = chat
        self._current = False
        self._badge = ""

    @override
    def render(self) -> Content:
        badge = f"{self._badge} " if self._badge else ""
        room = max(self.size.width - 2 - len(badge), 1)
        name = self.chat if len(self.chat) <= room else f"{self.chat[: room - 1]}…"
        return Content.assemble(("› " if self._current else "  ", "bold $primary"), name.ljust(room), (badge, "bold $primary"))

    def show(self, *, current: bool, unread: int, mark: str) -> None:
        badge = mark or (str(unread) if unread else "")
        if (current, badge) != (self._current, self._badge):
            self._current, self._badge = current, badge
            self.refresh()
        self.set_class(current, "-current")
        self.set_class(unread > 0, "-unread")

    async def on_click(self) -> None:
        await self.app.run_action(f"open_chat({self.chat!r})")


class MessageView(Vertical):
    """One note in a chat: who and when, what it answers, and the text. Notes from other people offer to run your agent."""

    def __init__(self, entry: Entry, *, me: str, header: bool, quote: str) -> None:
        super().__init__(classes="" if header else "-joined")
        self.entry = entry
        self._me = me
        self._header = header
        self._quote = quote

    @override
    def compose(self) -> ComposeResult:
        note = self.entry.note
        if not self.entry.trusted:
            yield Static(f"✗ a note claiming to be from {note.sender} failed its signature check and is hidden", classes="untrusted", markup=False)
            return
        if self._header:
            who = "you" if note.sender == self._me else note.sender
            colour = "$text" if note.sender == self._me else _colour_of(note.sender)
            when = datetime.fromtimestamp(note.ts, tz=UTC).astimezone().strftime("%H:%M")
            with Horizontal(classes="head"):
                yield Label(f"[b {colour}]{who}[/]{' [$dm-muted]· agent[/]' if note.agent else ''} [$dm-muted]· {when}[/]", classes="who")
                if is_request(self.entry, self._me):
                    yield Static(f"[@click=app.run_on({self.entry.id})]▶ Run my agent[/]", classes="run")
        if self._quote:
            yield Static(f"┃ {self._quote}", classes="quote", markup=False)
        if note.agent or "```" in note.body:
            yield Markdown(note.body, open_links=False)
        else:
            yield Static(note.body, classes="text", markup=False)

    def on_enter(self) -> None:
        self.add_class("-over")

    def on_leave(self) -> None:
        self.set_class(self.is_mouse_over, "-over")


class ThreadView(VerticalScroll):
    """The notes of one chat, oldest at the top, following new ones unless the user has scrolled up."""

    can_focus = False

    def __init__(self, chat: str, me: str, today: Callable[[], date], find: Callable[[int], Entry | None]) -> None:
        super().__init__(id=_thread_id(chat))
        self.chat = chat
        self._me = me
        self._today = today
        self._find = find
        self._last: Entry | None = None
        self._day: date | None = None
        self._waiting: list[Static | MessageView] = []  # Notes added before this view was on screen.
        self._open_request: int | None = None

    @override
    def compose(self) -> ComposeResult:
        yield Static(f"Nothing here yet. Write the first note to {self.chat}.", classes="none-yet", markup=False)

    def on_mount(self) -> None:
        self.anchor()
        self._show(self._waiting)
        self._waiting = []

    def append(self, entries: Iterable[Entry]) -> None:
        widgets: list[Static | MessageView] = []
        for entry in entries:
            day = datetime.fromtimestamp(entry.note.ts, tz=UTC).astimezone().date()
            if day != self._day:
                widgets.append(Static(self._day_label(day), classes="day", markup=False))
                self._day, self._last = day, None
            header = not continues(self._last, entry) or is_request(entry, self._me)  # A note you can run always keeps its header: that is where its button lives.
            answered = self._find(entry.note.re) if entry.note.re is not None else None
            quote = f"{answered.note.sender}: {_one_line(answered.note.body)}" if answered and answered.trusted else ""
            widgets.append(MessageView(entry, me=self._me, header=header, quote=quote))
            self._last = entry
        if self.is_mounted:
            self._show(widgets)
        else:
            self._waiting += widgets

    def _show(self, widgets: list[Static | MessageView]) -> None:
        if not widgets:
            return
        self.query(".none-yet").remove()
        for widget in widgets:
            if isinstance(widget, MessageView):
                widget.set_class(widget.entry.id == self._open_request, "-newest")
        self.mount_all(widgets)

    def mark_open_request(self, note_id: int | None) -> None:
        """Keep the run button visible on the one note still waiting for an answer."""
        self._open_request = note_id
        for view in [*self.query(MessageView), *(widget for widget in self._waiting if isinstance(widget, MessageView))]:
            view.set_class(view.entry.id == note_id, "-newest")

    def _day_label(self, day: date) -> str:
        days_ago = (self._today() - day).days
        return {0: "── today ──", 1: "── yesterday ──"}.get(days_ago, f"── {day:%a %-d %b} ──")


class Composer(TextArea):
    """The message box. Enter sends; Ctrl+J starts a new line."""

    BINDINGS: ClassVar[list[BindingType]] = [Binding("ctrl+j,shift+enter", "newline", "new line", show=False)]

    class Submitted(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    def on_key(self, event: events.Key) -> None:
        if event.key == "enter":
            event.prevent_default()
            event.stop()
            self.post_message(self.Submitted(self.text))

    def action_newline(self) -> None:
        self.insert("\n")

    def set_text(self, text: str) -> None:
        self.load_text(text)
        self.move_cursor(self.document.end)


class JoinChannel(ModalScreen[str]):
    """Ask which channel to join. The result is its name, or "" when the dialog is closed."""

    BINDINGS: ClassVar[list[BindingType]] = [Binding("escape", "dismiss('')", "close")]

    def __init__(self, others: Sequence[ChannelInfo]) -> None:
        super().__init__()
        self._others = others

    @override
    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog") as dialog:
            dialog.border_title = "Join or create a channel"
            dialog.border_subtitle = "Enter joins · Esc closes"
            yield Input(placeholder="channel name, for example backend", restrict=r"#?[a-z0-9_-]*", max_length=33)
            if self._others:
                yield Label("or pick one your teammates are in", classes="hint")
                yield OptionList(*(Option(f"{channel.name}  {', '.join(channel.members)}", id=channel.name) for channel in self._others))

    def on_input_submitted(self, event: Input.Submitted) -> None:
        name = event.value.strip().removeprefix("#")
        if name:
            self.dismiss(f"#{name}")

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(event.option.id or "")


class Help(ModalScreen[None]):
    BINDINGS: ClassVar[list[BindingType]] = [Binding("escape,f1,q", "dismiss", "close")]

    @override
    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog") as dialog:
            dialog.border_title = "Keys"
            dialog.border_subtitle = "[@click=screen.dismiss]Esc closes[/]"
            for key, does in KEYS:
                with Horizontal(classes="line"):
                    yield Label(key, classes="key", markup=False)
                    yield Label(does, classes="does", markup=False)
            yield Label("")
            yield Label(
                "Everything is clickable too: chats, the run button on a note, and the hints along the bottom. Hover a note to run your agent on it. Drag to select text.", classes="hint", markup=False
            )


class DeskmateApp(App[None]):
    """Chats, notes, and approval-gated agent runs for one person."""

    CSS = CSS
    TITLE = "deskmate"
    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("ctrl+r", "run_newest", "run my agent", priority=True),
        Binding("ctrl+n", "join_channel", "join channel", priority=True),
        Binding("ctrl+up,alt+up", "step_chat(-1)", "previous chat", priority=True),
        Binding("ctrl+down,alt+down", "step_chat(1)", "next chat", priority=True),
        Binding("f1", "help", "help", priority=True),
        Binding("escape", "stop_or_discard", "stop or discard"),
        Binding("ctrl+q", "quit", "quit", priority=True),
    ]

    def __init__(self, client: Client, cwd: Path, runner: Runner, *, poll_wait: float = POLL_WAIT) -> None:
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
        self.cwd = cwd
        self.runner = runner
        self._poll_wait = poll_wait
        self._stop_polling = threading.Event()
        self.me = client.config.name
        self.chats = ChatLog(self.me)
        self.people: list[str] = []
        self.channels: list[ChannelInfo] = []
        self.current = ""  # The open chat; "" until one exists.
        self.typed: dict[str, str] = {}  # Per chat, what is in the message box while another chat is open.
        self.drafts: dict[str, Draft] = {}
        self.runs: dict[str, AgentRun] = {}
        self.connected = False
        self.problem = ""
        self._loaded = False
        self._esc_at = 0.0
        self._frame = 0
        self._row_widgets: dict[str, ChatRow] = {}
        self._threads: dict[str, ThreadView] = {}
        self._hints: tuple[tuple[str, str, str], ...] = ()
        self.read = dict(self._state.read)

    # ── layout ────────────────────────────────────────────────────────────────

    @override
    def compose(self) -> ComposeResult:
        config = self.client.config
        home = str(Path.home())
        where = str(self.cwd).replace(home, "~", 1) if str(self.cwd).startswith(home) else str(self.cwd)
        with Horizontal(id="top"):
            yield Label(" deskmate ", id="brand")
            yield Label(f" {self.me} on {urlsplit(config.hub).netloc} · {config.agent} in {where}", id="identity", markup=False)
            yield Static("[@click=app.help]? Help[/] ", id="help-link")
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
        if is_channel(self.current):
            yield SystemCommand(f"Leave {self.current}", "Stop receiving this channel's notes", self.action_leave_channel)
        for row in self._rows():
            yield SystemCommand(f"Open {row.chat}", "Switch to this chat", partial(self.action_open_chat, row.chat))

    def on_mount(self) -> None:
        self.register_theme(TERMINAL_THEME)
        self.theme = self._start_theme
        self.ansi_color = None  # From here on, each theme says for itself whether it uses the terminal's colours.
        self._spinner = self.set_interval(0.1, self._spin, pause=True)
        self.query_one(Composer).focus()
        self.poller = threading.Thread(target=self._poll, daemon=True, name="deskmate-poll")
        self.poller.start()
        self._refresh()

    def on_unmount(self) -> None:
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

    # ── the hub, on worker threads ────────────────────────────────────────────

    def _ui(self, call: Callable[[], None]) -> None:
        self.post_message(_OnUiThread(call))

    def on__on_ui_thread(self, message: _OnUiThread) -> None:
        message.call()

    def _snapshot(self, after: int | None) -> tuple[list[str], list[ChannelInfo], list[Entry]]:
        people = [user.name for user in self.client.users()]
        channels = self.client.channels()
        batch = self.client.notes(tail=HISTORY) if after is None else self.client.notes(after=after, wait=self._poll_wait)
        return people, channels, [Entry(delivered.id, delivered.note, self.client.is_trusted(delivered.note)) for delivered in batch]

    def _poll(self) -> None:
        after: int | None = None
        while not self._stop_polling.is_set():
            try:
                people, channels, entries = self._snapshot(after)
            except (DeskmateError, ValidationError) as err:
                self._ui(partial(self._link_down, str(err)))
                self._stop_polling.wait(RETRY_DELAY)
                continue
            self._ui(partial(self._sync, people, channels, entries, after is None))
            after = max([after or 0, *(entry.id for entry in entries)])

    def _background(self, work: Callable[[], None], failed: Callable[[str], None]) -> None:
        def body() -> None:
            try:
                work()
            except (DeskmateError, ValidationError) as err:
                self._ui(partial(failed, str(err)))

        threading.Thread(target=body, daemon=True).start()

    def _link_down(self, problem: str) -> None:
        self.connected, self.problem = False, problem
        self._refresh()

    def _sync(self, people: list[str], channels: list[ChannelInfo], entries: list[Entry], first: bool) -> None:
        self.people, self.channels, self.connected, self.problem = people, channels, True, ""
        fresh = self.chats.add(entries)
        for chat in dict.fromkeys(chat_of(entry.note, self.me) for entry in fresh):
            if view := self._threads.get(chat):
                view.append(entry for entry in fresh if chat_of(entry.note, self.me) == chat)
        self._loaded = True
        if not self.current:
            rows = self._rows()
            if rows:  # Start where something is waiting; failing that, where the user left off.
                last = self._state.chat if self._state.chat in [row.chat for row in rows] else rows[0].chat
                self.action_open_chat(next((row.chat for row in rows if row.unread), last))
        if not first:
            self._announce([entry for entry in fresh if entry.note.sender != self.me])
        self._mark_read()
        self._refresh()

    def _announce(self, incoming: list[Entry]) -> None:
        elsewhere = [entry for entry in incoming if chat_of(entry.note, self.me) != self.current]
        for entry in elsewhere[-3:]:
            where = f" in {entry.note.to}" if is_channel(entry.note.to) else ""
            self.notify(_one_line(entry.note.body, 120) if entry.trusted else "a note failed its signature check", title=f"{entry.note.sender}{where}", markup=False)
        if incoming:
            self.bell()

    # ── state the widgets show ────────────────────────────────────────────────

    def _rows(self) -> list[Row]:
        return self.chats.rows(self.channels, self.people, self.read)

    def _today(self) -> date:
        return datetime.fromtimestamp(self.client.now(), tz=UTC).astimezone().date()

    def _mark_read(self) -> None:
        entries = self.chats.entries(self.current)
        newest = entries[-1].id if entries else 0
        if self.read.get(self.current, 0) < newest or self._state.chat != self.current:
            self.read[self.current] = max(newest, self.read.get(self.current, 0))
            self._save_state()

    def _save_state(self, theme: str | None = None) -> None:
        self._state = UiState(read=dict(self.read), theme=theme or self._state.theme, chat=self.current or self._state.chat)
        (self.client.home / "state.json").write_text(self._state.model_dump_json(indent=1))

    def _refresh(self) -> None:
        self._refresh_sidebar()
        self._refresh_pane()
        self._refresh_status()

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
        spinner = SPINNER[self._frame % len(SPINNER)]
        for row in rows:
            mark = spinner if row.chat in self.runs else ("✎" if row.chat in self.drafts else "")
            self._row_widgets[row.chat].show(current=row.chat == self.current, unread=row.unread, mark=mark)

    def _sort_rows(self) -> None:
        for group in ("#channel-rows", "#people-rows"):
            self.query_one(group, Vertical).sort_children(key=lambda widget: widget.chat if isinstance(widget, ChatRow) else "")

    def _refresh_pane(self) -> None:
        pane = self.query_one("#pane", Vertical)
        empty = self.query_one("#empty", Static)
        composer = self.query_one(Composer)
        if not self.current:
            pane.border_title = "deskmate"
            pane.border_subtitle = ""
            if self._loaded:
                empty.update("Nobody else has joined this hub yet.\nShare the install line with a teammate, or press Ctrl+N to start a channel.")
            return
        info = next((channel for channel in self.channels if channel.name == self.current), None)
        pane.border_title = f"{self.current} · {', '.join(info.members)}" if info else self.current
        pane.border_subtitle = "[@click=app.leave_channel]× Leave[/]" if info and self.me in info.members else ""
        composer.placeholder = f"Message {self.current}"
        waiting = self.chats.open_request(self.current)
        if view := self._threads.get(self.current):
            view.mark_open_request(waiting.id if waiting else None)

    def _refresh_status(self) -> None:
        status = self.query_one("#status", Horizontal)
        run, draft = self.runs.get(self.current), self.drafts.get(self.current)
        hints: list[tuple[str, str, str]] = []
        text = actions = ""
        discard = "[@click=app.discard_draft]× Discard[/]"
        if run:
            seconds = int(time.monotonic() - run.started)
            text = f"[$primary]{SPINNER[self._frame % len(SPINNER)]}[/] working on {run.entry.note.sender}'s note · {seconds}s"
            actions = "[@click=app.stop_or_discard]■ Stop[/]"
            hints += [("Esc", "stop my agent", "app.stop_or_discard"), ("Enter", "send", "")]
        elif draft and draft.loaded:
            text = f"[$primary]✎[/] Draft for {draft.entry.note.sender} · Enter sends it"
            actions = discard
            hints += [("Enter", "send draft", ""), ("Esc Esc", "discard", "app.discard_draft")]
        elif draft:
            text = f"[$primary]✎[/] Draft for {draft.entry.note.sender} is ready"
            actions = f"[@click=app.load_draft]Load it[/] · {discard}"
            hints += [("Enter", "send", "")]
        else:
            if self.current and self.chats.newest_request(self.current):
                hints.append(("^R", "run my agent", "app.run_newest"))
            hints.append(("Enter", "send", ""))
        self.query_one("#status-text", Static).update(text)
        self.query_one("#status-actions", Static).update(actions)
        status.set_class(bool(run or draft), "-on")
        hints += [("^↓", "next chat", "app.step_chat(1)"), ("^N", "join channel", "app.join_channel"), ("^P", "commands", "app.command_palette"), ("^Q", "quit", "app.quit")]
        state = "● connected " if self.connected else (f"◌ {_one_line(self.problem, 40)} · retrying " if self.problem else "◌ connecting ")
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
        self._refresh_status()

    def _set_spinning(self) -> None:
        if self.runs:
            self._spinner.resume()
        else:
            self._spinner.pause()

    # ── actions: every key, and everything clickable ──────────────────────────

    def action_open_chat(self, chat: str) -> None:
        composer = self.query_one(Composer)
        if self.current:
            self.typed[self.current] = composer.text
        self.current = chat
        switcher = self.query_one("#threads", ContentSwitcher)
        if chat not in self._threads:
            view = self._threads[chat] = ThreadView(chat, self.me, self._today, self.chats.find)
            view.append(self.chats.entries(chat)[-HISTORY:])
            switcher.add_content(view, set_current=True)
        else:
            switcher.current = _thread_id(chat)
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
            people, channels, entries = self._snapshot(None)  # A channel's earlier notes are older than the poll cursor, so load them now.
            self._ui(partial(self._joined, channel, people, channels, entries))

        self._background(work, partial(self._failed, f"could not join {channel}"))

    def _joined(self, channel: str, people: list[str], channels: list[ChannelInfo], entries: list[Entry]) -> None:
        self._sync(people, channels, entries, True)
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

    def _failed(self, what: str, problem: str) -> None:
        self.notify(problem, title=what, severity="error", markup=False)

    def on_composer_submitted(self, message: Composer.Submitted) -> None:
        chat, text = self.current, message.text.strip()
        if not chat or not text:
            return
        draft = self.drafts.get(chat)
        answering = draft if draft and draft.loaded else None
        composer = self.query_one(Composer)
        composer.set_text("")
        self.typed[chat] = ""
        if answering:
            del self.drafts[chat]
        self._refresh()

        def work() -> None:
            self.client.send(chat, text[:MAX_BODY], agent=answering is not None, re=answering.entry.id if answering else None)

        self._background(work, partial(self._send_failed, chat, text, answering))

    def _send_failed(self, chat: str, text: str, answering: Draft | None, problem: str) -> None:
        """Put an unsent message back where it was, so nothing the user or their agent wrote is lost."""
        if answering:
            self.drafts[chat] = answering
        if not self.typed.get(chat) and not (chat == self.current and self.query_one(Composer).text):
            self.typed[chat] = text
            if chat == self.current:
                self.query_one(Composer).set_text(text)
        self._failed(f"not sent to {chat}", problem)
        self._refresh()

    def action_run_newest(self) -> None:
        newest = self.chats.newest_request(self.current) if self.current else None
        if newest:
            self._start_run(newest)
        else:
            self.notify("No note from someone else in this chat to run your agent on.", markup=False)

    def action_run_on(self, note_id: int) -> None:
        entry = self.chats.find(note_id)
        if entry and is_request(entry, self.me):
            self._start_run(entry)

    def _start_run(self, entry: Entry) -> None:
        chat = chat_of(entry.note, self.me)
        if chat in self.runs:
            self.notify(f"Your agent is already working in {chat}.", markup=False)
            return
        try:
            argv = [*shlex.split(self.client.config.agent), agent_prompt(entry, self.me, self.chats.earlier(entry))]
        except ValueError as err:
            self._failed("agent command", f'cannot read "agent" in config.json: {err}')
            return
        run = AgentRun(entry, threading.Event(), time.monotonic(), threading.Event())
        self.runs[chat] = run

        def work() -> None:
            try:
                text = self.runner(argv, self.cwd, run.cancel)
            except AgentCancelledError:
                self._ui(partial(self._run_ended, chat, run, "", "stopped"))
            except DeskmateError as err:
                self._ui(partial(self._run_ended, chat, run, "", str(err)))
            else:
                self._ui(partial(self._run_ended, chat, run, text, ""))
            finally:
                run.done.set()

        threading.Thread(target=work, daemon=True, name="deskmate-agent").start()
        self._set_spinning()
        self._refresh()

    def _run_ended(self, chat: str, run: AgentRun, text: str, problem: str) -> None:
        if self.runs.get(chat) is run:
            del self.runs[chat]
        self._set_spinning()
        if problem == "stopped":
            self.notify("Stopped your agent.", markup=False)
        elif problem or not text:
            self._failed("your agent", problem or "the agent returned nothing")
        else:
            box_is_empty = not (self.query_one(Composer).text if chat == self.current else self.typed.get(chat, ""))
            self.drafts[chat] = Draft(text[:MAX_BODY], run.entry, loaded=False)
            if box_is_empty:
                self._load_draft(chat)
            if chat != self.current:
                self.notify("Your agent's draft is ready to review.", title=chat, markup=False)
            self.bell()
        self._refresh()

    def _load_draft(self, chat: str) -> None:
        draft = self.drafts[chat]
        self.drafts[chat] = dataclasses.replace(draft, loaded=True)
        self.typed[chat] = draft.text
        if chat == self.current:
            self.query_one(Composer).set_text(draft.text)

    def action_load_draft(self) -> None:
        if self.current in self.drafts:
            self._load_draft(self.current)
            self._refresh()

    def action_discard_draft(self) -> None:
        draft = self.drafts.pop(self.current, None)
        if draft and draft.loaded:
            self.typed[self.current] = ""
            self.query_one(Composer).set_text("")
        self._refresh()

    def action_stop_or_discard(self) -> None:
        """Esc: stop the agent working in this chat, or, pressed twice, discard the draft being reviewed."""
        if run := self.runs.get(self.current):
            run.cancel.set()
        elif self.current in self.drafts:
            if time.monotonic() - self._esc_at <= DISCARD_WINDOW:
                self.action_discard_draft()
            else:
                self._esc_at = time.monotonic()
                self.notify("Press Esc again to discard the draft.", timeout=DISCARD_WINDOW, markup=False)
