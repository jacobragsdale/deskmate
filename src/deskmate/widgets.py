"""The pieces the chat interface is built from: the chat list rows, notes, the message box, the dialogs, and how they look."""

from collections.abc import Callable, Iterable, Sequence
from datetime import UTC, date, datetime
from pathlib import Path
from typing import ClassVar, override

from textual import events
from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.content import Content
from textual.message import Message
from textual.screen import ModalScreen
from textual.widget import Widget
from textual.widgets import Input, Label, Markdown, OptionList, Static, TextArea
from textual.widgets.option_list import Option

from deskmate.chat import MENTION, ChatLog, Entry, continues, mentions
from deskmate.wire import ChannelInfo, is_channel

NAME_COLOURS = ("$accent", "$secondary", "$success", "$warning", "$primary")

KEYS = (
    ("@", "tag an agent: yours runs at once, a teammate's waits for them"),
    ("Enter", "send the message, or the draft you are reviewing"),
    ("Ctrl+J", "new line in the message"),
    ("Ctrl+R", "run the oldest request waiting for one of your agents"),
    ("Esc", "stop your agents in this chat; press twice to discard a draft"),
    ("Ctrl+↑ / Ctrl+↓", "previous or next chat"),
    ("Ctrl+N", "join or create a channel"),
    ("Ctrl+P", "commands: open a chat, pin a repo, leave a channel, change theme"),
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
MessageView .who { height: 1; text-wrap: nowrap; text-overflow: ellipsis; }
MessageView .quote { height: 1; color: $dm-muted; text-wrap: nowrap; text-overflow: ellipsis; }
MessageView .text { height: auto; }
MessageView .untrusted { height: auto; color: $error; }
MessageView .bar { height: auto; color: $dm-muted; link-color: $primary; display: none; }
MessageView .bar.-on { display: block; }
MessageView Markdown { margin: 0; padding: 0; background: transparent; }
MessageView MarkdownFence { margin: 0 0 1 0; padding: 0 1; border-left: heavy $dm-border; color: $foreground; background: transparent; }
MessageView MarkdownFence > Label { padding: 0; }
MessageView Markdown > *:last-child { margin-bottom: 0; }

#status { height: 1; margin-top: 1; display: none; }
#status.-on { display: block; }
#status-text { width: 1fr; color: $dm-muted; text-wrap: nowrap; text-overflow: ellipsis; }
#status-actions { width: auto; margin-left: 2; link-color: $primary; }
#picker { height: auto; max-height: 10; margin-top: 1; padding: 0; border: none; background: transparent; display: none; }
#picker.-on { display: block; }
#picker > .option-list--option-highlighted { color: $foreground; background: $dm-selected; text-style: bold; }
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

ModalScreen { align: center middle; }
.dialog { width: 64; max-width: 90%; height: auto; max-height: 90%; padding: 1 2; border: round $primary; border-title-color: $primary; border-title-style: bold; border-subtitle-color: $dm-muted; background: $surface; }
.dialog Input { border: none; height: 1; padding: 0; margin-bottom: 1; background: transparent; }
.dialog Input:focus { border: none; }
.dialog OptionList { height: auto; max-height: 12; border: none; padding: 0; margin-bottom: 1; background: transparent; }
.dialog .hint { width: 100%; height: auto; color: $dm-muted; }
.dialog .key { width: 18; color: $primary; text-style: bold; }
.dialog .does { width: 1fr; }
.dialog .line { height: auto; }
.dialog .fact { width: 100%; height: auto; margin-bottom: 1; }
.dialog .choices { width: 100%; height: 1; link-color: $primary; }
"""


def _colour_of(name: str) -> str:
    return NAME_COLOURS[sum(name.encode()) % len(NAME_COLOURS)]


def one_line(text: str, width: int = 60) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= width else flat[: width - 1] + "…"


def thread_id(chat: str) -> str:
    return f"channel-{chat[1:]}" if is_channel(chat) else f"person-{chat}"


def _with_tags(body: str) -> Content:
    """A note's text with every "@person/repo" picked out."""
    parts: list[str | tuple[str, str]] = []
    end = 0
    for match in MENTION.finditer(body):
        parts += [body[end : match.start()], (match.group(0), "bold $primary")]
        end = match.end()
    return Content.assemble(*parts, body[end:])


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
    """One chat in the list: a marker when it is open, whether the person is here, its name, and what is waiting in it."""

    def __init__(self, chat: str) -> None:
        super().__init__()
        self.chat = chat
        self._shown: tuple[bool, str, bool | None] = (False, "", None)

    @override
    def render(self) -> Content:
        current, mark, here = self._shown
        badge = f"{mark} " if mark else ""
        presence: list[tuple[str, str]] = [] if here is None else [("● ", "$success") if here else ("○ ", "$dm-muted")]
        room = max(self.size.width - 2 - 2 * len(presence) - len(badge), 1)
        name = self.chat if len(self.chat) <= room else f"{self.chat[: room - 1]}…"
        return Content.assemble(("› " if current else "  ", "bold $primary"), *presence, name.ljust(room), (badge, "bold $primary"))

    def show(self, *, current: bool, unread: int, mark: str, here: bool | None) -> None:
        """`here` is None for a channel, which is neither present nor away."""
        shown = (current, mark or (str(unread) if unread else ""), here)
        if shown != self._shown:
            self._shown = shown
            self.refresh()
        self.set_class(current, "-current")
        self.set_class(unread > 0, "-unread")

    async def on_click(self) -> None:
        await self.app.run_action(f"open_chat({self.chat!r})")


class MessageView(Vertical):
    """One note in a chat: who and when, what it answers, the text, and what each agent it tags is doing."""

    def __init__(self, entry: Entry, *, me: str, header: bool, quote: str, branch: str) -> None:
        super().__init__(classes="" if header else "-joined")
        self.entry = entry
        self._me = me
        self._header = header
        self._quote = quote
        self._branch = branch
        self.bar = Static(classes="bar")  # Held here, not looked up later: it can be updated before this note is on screen.

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
            agent = f"/{note.agent} agent{f' on {self._branch}' if self._branch else ''}" if note.agent else ""
            yield Label(Content.assemble((who, f"bold {colour}"), (f"{agent} · {when}", "$dm-muted")), classes="who")
        if self._quote:
            yield Static(f"┃ {self._quote}", classes="quote", markup=False)
        if note.agent or "```" in note.body:
            yield Markdown(note.body, open_links=False)
        else:
            yield Static(_with_tags(note.body), classes="text")
        yield self.bar

    def set_bar(self, markup: str) -> None:
        self.bar.update(markup)
        self.bar.set_class(bool(markup), "-on")


class ThreadView(VerticalScroll):
    """The notes of one chat, oldest at the top, following new ones unless the user has scrolled up."""

    can_focus = False

    def __init__(self, chat: str, log: ChatLog, today: Callable[[], date]) -> None:
        super().__init__(id=thread_id(chat))
        self.chat = chat
        self._log = log
        self._today = today
        self._last: Entry | None = None
        self._day: date | None = None
        self._waiting: list[Static | MessageView] = []  # Notes added before this view was on screen.
        self.tagging: dict[int, MessageView] = {}  # The notes that tag an agent, by id: the ones whose status line changes.

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
            note = entry.note
            day = datetime.fromtimestamp(note.ts, tz=UTC).astimezone().date()
            if day != self._day:
                widgets.append(Static(self._day_label(day), classes="day", markup=False))
                self._day, self._last = day, None
            answered = self._log.find(note.re) if note.re is not None else None
            quote = f"{answered.note.sender}: {one_line(answered.note.body)}" if answered and answered.trusted else ""
            view = MessageView(entry, me=self._log.me, header=not continues(self._last, entry), quote=quote, branch=self._log.ran_on(entry))
            if entry.trusted and note.agent is None and mentions(note.body):
                self.tagging[entry.id] = view
            widgets.append(view)
            self._last = entry
        if self.is_mounted:
            self._show(widgets)
        else:
            self._waiting += widgets

    def _show(self, widgets: list[Static | MessageView]) -> None:
        if widgets:
            self.query(".none-yet").remove()
            self.mount_all(widgets)

    def _day_label(self, day: date) -> str:
        days_ago = (self._today() - day).days
        return {0: "── today ──", 1: "── yesterday ──"}.get(days_ago, f"── {day:%a %-d %b} ──")


class Composer(TextArea):
    """The message box. Enter sends; Ctrl+J starts a new line. While the tag list is open, its keys go there."""

    BINDINGS: ClassVar[list[BindingType]] = [Binding("ctrl+j,shift+enter", "newline", "new line", show=False)]
    completing = False  # Whether the tag list is open.

    class Submitted(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    class ListKey(Message):
        """A key meant for the tag list while it is open."""

        def __init__(self, key: str) -> None:
            super().__init__()
            self.key = key

    def on_key(self, event: events.Key) -> None:
        if self.completing and event.key in {"up", "down", "enter", "tab", "escape"}:
            event.prevent_default()
            event.stop()
            self.post_message(self.ListKey(event.key))
        elif event.key == "enter":
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


class PickRepo(ModalScreen[str]):
    """Choose one of your repos. The result is its name, or "" when the dialog is closed."""

    BINDINGS: ClassVar[list[BindingType]] = [Binding("escape", "dismiss('')", "close")]

    def __init__(self, title: str, names: Sequence[str]) -> None:
        super().__init__()
        self._title = title
        self._names = names

    @override
    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog") as dialog:
            dialog.border_title = self._title
            dialog.border_subtitle = "Enter picks · Esc closes"
            yield Input(placeholder="type to narrow the list")
            yield OptionList(*(Option(name, id=name) for name in self._names))

    def on_input_changed(self, event: Input.Changed) -> None:
        wanted = event.value.strip().lower()
        options = self.query_one(OptionList)
        options.clear_options()
        options.add_options([Option(name, id=name) for name in self._names if wanted in name])
        options.highlighted = 0 if options.option_count else None

    def on_input_submitted(self) -> None:
        options = self.query_one(OptionList)
        if options.highlighted is not None:
            self.dismiss(options.get_option_at_index(options.highlighted).id or "")

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(event.option.id or "")


class ConfirmClone(ModalScreen[bool]):
    """Show exactly what will be cloned and where, and ask before doing it."""

    BINDINGS: ClassVar[list[BindingType]] = [Binding("escape", "dismiss(False)", "cancel"), Binding("enter", "dismiss(True)", "clone")]

    def __init__(self, url: str, destination: Path) -> None:
        super().__init__()
        self._url = url
        self._destination = destination

    @override
    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog") as dialog:
            dialog.border_title = "Clone this repo?"
            dialog.border_subtitle = "Enter clones · Esc cancels"
            yield Label(f"from  {self._url}", classes="fact", markup=False)
            yield Label(f"into  {self._destination}", classes="fact", markup=False)
            yield Label("It uses your own git credentials. An agent you run there reads that repo's instruction files.", classes="hint fact", markup=False)
            yield Static("[@click=screen.dismiss(True)]⇣ Clone[/]   [@click=screen.dismiss(False)]× Cancel[/]", classes="choices")


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
                "An agent is someone's copy of a repo under ~/dev, tagged as @person/repo. Everything is clickable too: chats, the choices under a note that tags your agent, and the hints along the bottom. Drag to select text.",
                classes="hint",
                markup=False,
            )
