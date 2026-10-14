/** One person's Player Two session: follows the hub, shares their repos, runs their agents when they say so, and keeps what the window shows. No window code. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

import { z } from "zod";

import type { Arrival, ChatView, Command, CurrentView, MessageView, Notice, RequestView, RowView } from "../shared/ipc.ts";
import { agentPrompt, ChatLog, chatOf, continues, mentions, ONLINE, refOf, rings } from "../core/chat.ts";
import type { Entry, Request } from "../core/chat.ts";
import { runAgent, splitCommand } from "./agents/oneshot.ts";
import { AgentCancelledError, PlayerTwoError, POLL_WAIT } from "./client.ts";
import type { Client, Runner } from "./client.ts";
import * as repos from "./repos.ts";
import type { Checkout } from "./repos.ts";
import { oneLine } from "../core/text.ts";
import { fitBody, isChannel, nameSchema, PROTOCOL } from "../core/wire.ts";
import type { ChannelInfo, Person, RepoRef, TeamRepo } from "../core/wire.ts";

const HISTORY = 300; // Notes loaded when the session starts or a channel is joined.
const RETRY_DELAY = 5; // Seconds to wait before asking a hub that did not answer again.
const UPDATE_DELAY = 60; // Seconds to wait before asking a hub on another protocol again: its answer changes only when someone updates one side.
const STOP_WAIT = 3; // Seconds to give stopped agents to go before the session is done.

/** What the session remembers between runs, in app-state.json. */
const savedSchema = z.strictObject({ read: z.record(z.string(), z.int()), chat: z.string().nullable() });

export interface Hooks {
  readonly changed: () => void; // What `view()` returns is different now.
  readonly notice: (notice: Notice) => void;
  readonly arrived: (arrival: Arrival) => void;
  readonly confirmClone: (url: string, destination: string) => Promise<boolean>; // Show where a clone comes from and goes to, before anything is fetched.
}

export interface Options {
  readonly runner?: Runner;
  readonly cloner?: (url: string, destination: string) => Promise<void>;
  readonly describe?: (checkout: Checkout) => Promise<string>;
  readonly pollWait?: number;
}

/** An agent's answer waiting for its owner to review, edit and send. */
interface Draft {
  readonly text: string;
  readonly entry: Entry; // The note it answers.
  readonly repo: string; // The repo the agent worked in.
}

interface AgentRun {
  readonly entry: Entry;
  readonly repo: string;
  readonly post: boolean; // Post the answer as soon as it is ready, rather than drafting it for review.
  readonly cancel: AbortController;
  readonly startedAt: number; // Unix milliseconds.
  done: Promise<void>; // Settles once the agent's process is gone and the chat has been told how it ended.
}

interface Snapshot {
  readonly people: readonly Person[];
  readonly channels: readonly ChannelInfo[];
  readonly team: readonly TeamRepo[];
  readonly entries: readonly Entry[];
}

type ChatCommand = Exclude<Command, { do: "join" }>;

function sleep(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** A failure in words the user can act on. */
export function problemOf(error: unknown): string {
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return first === undefined ? "invalid input" : `invalid ${first.path.length === 0 ? "input" : first.path.join(".")}: ${first.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function runKey(noteId: number, repo: string): string {
  return `${String(noteId)} ${repo}`;
}

function dayOf(ts: number): string {
  return new Date(ts * 1000).toDateString();
}

export class Session {
  private readonly client: Client;
  private readonly dev: string;
  private readonly hooks: Hooks;
  private readonly runner: Runner;
  private readonly cloner: (url: string, destination: string) => Promise<void>;
  private readonly describe: (checkout: Checkout) => Promise<string>;
  private readonly pollWait: number;
  private readonly me: string;
  private readonly chats: ChatLog;
  private readonly stopping = new AbortController();
  private readonly drafts = new Map<string, Draft[]>(); // Per chat, answers waiting for review, oldest first.
  private readonly runs = new Map<string, AgentRun>(); // By tagging note and repo.
  private readonly autorun = new Set<number>(); // Notes just sent from here: their tags of the user's own agents run without asking.
  private readonly read: Record<string, number>; // Per chat, the id of the newest note the user has seen.
  private lastChat: string | null; // The chat that was open when the session last ran.
  private people: readonly Person[] = [];
  private channels: readonly ChannelInfo[] = [];
  private team: readonly TeamRepo[] = []; // Every repo anyone has checked out.
  private checkouts = new Map<string, Checkout>(); // The user's own, by repo name.
  private prefix = ""; // The key every repo this hub shares starts with; "" until the hub has said.
  private advertised: string | null = null; // What the hub was last told about the user's repos.
  private current = ""; // The open chat; "" until one exists.
  private newAfter: number | null = null;
  private connected = false;
  private problem = "";
  private loaded = false;
  private attentive = true; // Whether the user is looking at the window. Notes that arrive while they are not stay unread.
  private polling: Promise<void> = Promise.resolve();

  constructor(client: Client, dev: string, hooks: Hooks, options: Options = {}) {
    this.client = client;
    this.dev = dev;
    this.hooks = hooks;
    this.runner = options.runner ?? runAgent;
    this.cloner = options.cloner ?? repos.clone;
    this.describe = options.describe ?? repos.describe;
    this.pollWait = options.pollWait ?? POLL_WAIT;
    this.me = client.config.name;
    this.chats = new ChatLog(this.me);
    const saved = this.loadSaved();
    this.read = { ...saved.read };
    this.lastChat = saved.chat;
  }

  public start(): void {
    this.polling = this.poll();
  }

  /** Stop following the hub and stop every agent still working, waiting briefly so each is gone and the chat has been told. */
  public async stop(): Promise<void> {
    this.stopping.abort();
    const runs = [...this.runs.values()];
    for (const run of runs) {
      run.cancel.abort();
    }
    await Promise.race([Promise.all([this.polling, ...runs.map((run) => run.done)]), sleep(STOP_WAIT)]);
  }

  public isOpen(chat: string): boolean {
    return this.current === chat;
  }

  /** Say whether the user is looking at the window. Coming back marks the open chat read, with a line where they left off. */
  public attend(attentive: boolean): void {
    this.attentive = attentive;
    const mark = this.read[this.current] ?? 0;
    if (attentive && this.current !== "" && this.chats.unread(this.current, mark) > 0) {
      this.newAfter = mark;
      this.markRead();
      this.hooks.changed();
    }
  }

  public async handle(command: ChatCommand): Promise<void> {
    switch (command.do) {
      case "open":
        this.open(command.chat);
        break;
      case "send":
        await this.send(command.chat, command.text);
        break;
      case "sendDraft":
        await this.sendDraft(command.chat, command.noteId, command.repo, command.text);
        break;
      case "discardDraft":
        await this.discardDraft(command.chat, command.noteId, command.repo);
        break;
      case "run":
        this.runRequest(command.noteId, command.repo, command.post);
        break;
      case "stop":
        this.runs.get(runKey(command.noteId, command.repo))?.cancel.abort();
        break;
      case "decline":
        await this.decline(command.noteId, command.repo);
        break;
      case "joinChannel":
        await this.joinChannel(command.name);
        break;
      case "leaveChannel":
        await this.leaveChannel(command.chat);
        break;
      case "pin":
        await this.pin(command.chat, command.repo);
        break;
      case "unpin":
        this.setChannel(await this.client.unpin(command.chat));
        break;
      case "clone":
        await this.clone(command.repo);
        break;
    }
  }

  // ── what the window shows ─────────────────────────────────────────────────

  public view(): ChatView {
    const now = this.client.now();
    const rows = this.rows();
    const working = new Set([...this.runs.values()].map((run) => chatOf(run.entry.note, this.me)));
    const asked = new Map(rows.map((row) => [row.chat, this.chats.waitingForMe(row.chat, now).length]));
    const rowViews: RowView[] = rows.map((row) => {
      let mark: RowView["mark"] = "";
      if (working.has(row.chat)) {
        mark = "working";
      } else if ((this.drafts.get(row.chat)?.length ?? 0) > 0) {
        mark = "draft";
      } else if ((asked.get(row.chat) ?? 0) > 0) {
        mark = "asked";
      }
      return { chat: row.chat, unread: row.unread, mark, here: isChannel(row.chat) ? null : this.here(row.chat) };
    });
    const home = homedir();
    let link: ChatView["link"] = { state: "connecting" };
    if (this.connected) {
      link = { state: "connected" };
    } else if (this.problem !== "") {
      link = { state: "down", problem: this.problem };
    }
    return {
      kind: "chat",
      me: this.me,
      hub: new URL(this.client.config.hub).host,
      agent: this.client.config.agent,
      dev: this.dev.startsWith(home) ? `~${this.dev.slice(home.length)}` : this.dev,
      link,
      loaded: this.loaded,
      rows: rowViews,
      waiting: [...asked.values()].reduce((sum, count) => sum + count, 0),
      unread: rows.reduce((sum, row) => sum + row.unread, 0),
      team: this.team,
      myRepos: [...this.checkouts.keys()],
      otherChannels: this.channels.filter((channel) => !channel.members.includes(this.me)).map((channel) => ({ name: channel.name, members: channel.members })),
      busy: { working: this.runs.size, unsent: [...this.drafts.values()].reduce((sum, drafts) => sum + drafts.length, 0) },
      current: this.current === "" ? null : this.currentView(now)
    };
  }

  private currentView(now: number): CurrentView {
    const chat = this.current;
    const info = this.channels.find((channel) => channel.name === chat);
    const members = info?.members ?? [];
    const pinned = info?.repo ?? null;
    return {
      chat,
      members: isChannel(chat) ? members : null,
      joined: members.includes(this.me),
      pinned:
        pinned === null
          ? null
          : { name: pinned.name, have: members.filter((member) => this.team.some((repo) => repo.user === member && repo.key === pinned.key)).length, mine: this.checkouts.has(pinned.name) },
      newAfter: this.newAfter,
      messages: this.messages(chat, now),
      drafts: (this.drafts.get(chat) ?? []).map((draft) => ({ noteId: draft.entry.id, repo: draft.repo, asker: draft.entry.note.sender, text: draft.text })),
      running: [...this.runs.values()].some((run) => chatOf(run.entry.note, this.me) === chat)
    };
  }

  private messages(chat: string, now: number): MessageView[] {
    const messages: MessageView[] = [];
    let previous: Entry | null = null;
    let marked = false;
    // ponytail: every note of the open chat is sent to the window on each change. Send only what is new if long chats make it slow.
    for (const entry of this.chats.entries(chat)) {
      const note = entry.note;
      const firstNew: boolean = !marked && this.newAfter !== null && entry.id > this.newAfter && note.sender !== this.me;
      marked ||= firstNew;
      if (firstNew || (previous !== null && dayOf(previous.note.ts) !== dayOf(note.ts))) {
        previous = null; // The first note of a day, and the first after the "new" line, says who wrote it.
      }
      const answered = note.re === null ? null : this.chats.find(note.re);
      messages.push({
        id: entry.id,
        sender: note.sender,
        agent: note.agent,
        branch: this.chats.ranOn(entry),
        ts: note.ts,
        trusted: entry.trusted,
        body: entry.trusted ? note.body : "",
        quote: answered?.trusted === true ? `${answered.note.sender}: ${oneLine(answered.note.body)}` : "",
        header: !continues(previous, entry),
        requests: this.chats.requests(entry, now).flatMap((request) => this.requestView(request))
      });
      previous = entry;
    }
    return messages;
  }

  /** Where one tagged agent stands: for the user's own, what they can do; for a teammate's, how far it has got. Nothing once it is answered. */
  private requestView(request: Request): RequestView[] {
    const { owner, repo } = request;
    const mine = owner === this.me;
    return request.state === "answered" ? [] : [{ noteId: request.entry.id, owner, repo, mine, status: mine ? this.myStatus(request) : this.theirStatus(request) }];
  }

  private myStatus(request: Request): RequestView["status"] {
    const { repo, state } = request;
    const noteId = request.entry.id;
    const run = this.runs.get(runKey(noteId, repo));
    if ((this.drafts.get(chatOf(request.entry.note, this.me)) ?? []).some((draft) => draft.entry.id === noteId && draft.repo === repo)) {
      return { kind: "drafted" };
    }
    if (run !== undefined) {
      return { kind: "running", startedAt: run.startedAt, branch: request.detail };
    }
    if (!this.checkouts.has(repo)) {
      return { kind: "noCheckout" };
    }
    const before = state === "working" ? "interrupted" : state === "waiting" || state === "answered" ? "" : state;
    return { kind: "ready", before, canDecline: request.entry.note.sender !== this.me && state !== "declined" };
  }

  private theirStatus(request: Request): RequestView["status"] {
    const { owner, repo, state } = request;
    if (state === "working") {
      return { kind: "working", branch: request.detail };
    }
    if (state === "declined" || state === "failed" || state === "stopped") {
      return { kind: state };
    }
    if (this.people.every((person) => person.name !== owner)) {
      return { kind: "nobody" };
    }
    if (this.team.every((theirs) => theirs.user !== owner || theirs.name !== repo)) {
      return { kind: "lacksRepo" };
    }
    return { kind: "waiting", away: !this.here(owner) };
  }

  private rows(): { readonly chat: string; readonly unread: number }[] {
    return this.chats.rows(
      this.channels,
      this.people.map((person) => person.name),
      this.read
    );
  }

  private here(name: string): boolean {
    return this.people.some((person) => person.name === name && this.client.now() - person.seen <= ONLINE);
  }

  // ── following the hub ─────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    const stopped = (): boolean => this.stopping.signal.aborted; // Asked afresh each time: it changes while this waits.
    let after: number | null = null;
    let greeted = false; // Whether the hub has said it speaks this protocol since it last failed to answer.
    while (!stopped()) {
      let retry = RETRY_DELAY;
      try {
        if (!greeted) {
          const info = await this.client.info();
          if (info.protocol !== PROTOCOL) {
            retry = UPDATE_DELAY;
            throw new PlayerTwoError(`the hub speaks protocol ${String(info.protocol)} and this app speaks protocol ${String(PROTOCOL)}: update the ${info.protocol > PROTOCOL ? "app" : "hub"}`);
          }
          this.prefix = info.repos;
          greeted = true;
        }
        await this.share();
        const snapshot = await this.snapshot(after);
        if (stopped()) {
          return;
        }
        this.sync(snapshot, after === null);
        after = Math.max(after ?? 0, ...snapshot.entries.map((entry) => entry.id));
      } catch (error) {
        if (stopped()) {
          return;
        }
        greeted = false;
        this.connected = false;
        this.problem = problemOf(error);
        this.hooks.changed();
        await sleep(retry, this.stopping.signal);
      }
    }
  }

  /** Look under ~/dev for the team's repos and tell the hub when the list or a branch has changed. */
  private async share(): Promise<void> {
    const found = repos.scan(this.dev, this.prefix);
    const adverts = found.map((checkout) => ({ ...checkout.remote, branch: checkout.branch }));
    if (JSON.stringify(adverts) !== this.advertised) {
      await this.client.advertise(adverts);
      this.advertised = JSON.stringify(adverts);
    }
    this.checkouts = new Map(found.map((checkout) => [checkout.remote.name, checkout]));
    this.hooks.changed();
  }

  private async snapshot(after: number | null): Promise<Snapshot> {
    const [people, channels, team] = await Promise.all([this.client.users(), this.client.channels(), this.client.repos()]);
    const batch = after === null ? await this.client.notes({ tail: HISTORY }) : await this.client.notes({ after, wait: this.pollWait, signal: this.stopping.signal });
    const entries: Entry[] = [];
    for (const delivered of batch) {
      entries.push({ id: delivered.id, note: delivered.note, trusted: await this.client.isTrusted(delivered.note) });
    }
    return { people, channels, team, entries };
  }

  private sync(snapshot: Snapshot, first: boolean): void {
    this.people = snapshot.people;
    this.channels = snapshot.channels;
    this.team = snapshot.team;
    this.connected = true;
    this.problem = "";
    this.loaded = true;
    const fresh = this.chats.add(snapshot.entries);
    for (const entry of fresh) {
      if (this.autorun.has(entry.id)) {
        this.runOwnTags(entry);
      }
    }
    if (this.current === "") {
      const rows = this.rows();
      const start = rows.find((row) => row.unread > 0) ?? rows.find((row) => row.chat === this.lastChat) ?? rows[0]; // Start where something is waiting; failing that, where the user left off.
      if (start !== undefined) {
        this.open(start.chat);
      }
    }
    if (!first) {
      this.announce(fresh.filter((entry) => entry.note.kind === "note" && entry.note.sender !== this.me));
    }
    this.markRead();
    this.hooks.changed();
  }

  private announce(incoming: readonly Entry[]): void {
    for (const entry of incoming.slice(-3)) {
      const note = entry.note;
      const tagged = entry.trusted && note.agent === null ? mentions(note.body).filter(([owner]) => owner === this.me) : [];
      const where = isChannel(note.to) ? ` in ${note.to}` : "";
      const title = tagged[0] === undefined ? `${note.sender}${where}` : `${note.sender} tagged your ${tagged[0][1]} agent${where}`;
      this.hooks.arrived({
        chat: chatOf(note, this.me),
        title,
        body: entry.trusted ? oneLine(note.body, 120) : "a note failed its signature check",
        forMe: tagged.length > 0,
        rings: rings(entry, this.me)
      });
    }
  }

  private markRead(): void {
    if (this.current === "" || !this.attentive) {
      return;
    }
    const newest = this.chats.entries(this.current).at(-1)?.id ?? 0;
    if ((this.read[this.current] ?? 0) < newest || this.lastChat !== this.current) {
      this.read[this.current] = Math.max(newest, this.read[this.current] ?? 0);
      this.lastChat = this.current;
      writeFileSync(this.savedPath(), JSON.stringify(savedSchema.parse({ read: this.read, chat: this.lastChat }), null, 1));
    }
  }

  private savedPath(): string {
    return joinPath(this.client.home, "app-state.json");
  }

  private loadSaved(): z.infer<typeof savedSchema> {
    try {
      if (existsSync(this.savedPath())) {
        return savedSchema.parse(JSON.parse(readFileSync(this.savedPath(), "utf8")));
      }
    } catch {
      // A file from another version only costs read marks and the last open chat.
    }
    return { read: {}, chat: null };
  }

  // ── what the user does ────────────────────────────────────────────────────

  private open(chat: string): void {
    if (chat === this.current || !this.rows().some((row) => row.chat === chat)) {
      return;
    }
    const mark = this.read[chat];
    this.newAfter = mark !== undefined && this.chats.unread(chat, mark) > 0 ? mark : null; // A chat never opened has no "left off".
    this.current = chat;
    this.markRead();
    this.hooks.changed();
  }

  private async send(chat: string, text: string): Promise<void> {
    const body = fitBody(text.trim());
    if (body === "") {
      return;
    }
    // A note typed here runs its tags of the user's own agents without asking, whichever arrives first: the hub's receipt or the note itself.
    const noteId = await this.client.send(chat, body);
    this.autorun.add(noteId);
    const entry = this.chats.find(noteId);
    if (entry !== null) {
      this.runOwnTags(entry);
    }
  }

  private runOwnTags(entry: Entry): void {
    this.autorun.delete(entry.id);
    if (entry.note.sender !== this.me) {
      return;
    }
    for (const request of this.chats.requests(entry, this.client.now())) {
      if (request.owner === this.me && request.state === "waiting" && this.checkouts.has(request.repo)) {
        this.startRun(entry, request.repo, true);
      }
    }
  }

  private takeDraft(chat: string, noteId: number, repo: string): Draft {
    const drafts = this.drafts.get(chat) ?? [];
    const draft = drafts.find((candidate) => candidate.entry.id === noteId && candidate.repo === repo);
    if (draft === undefined) {
      throw new PlayerTwoError("that draft is no longer waiting");
    }
    this.drafts.set(
      chat,
      drafts.filter((candidate) => candidate !== draft)
    );
    this.hooks.changed();
    return draft;
  }

  private async sendDraft(chat: string, noteId: number, repo: string, text: string): Promise<void> {
    const draft = this.takeDraft(chat, noteId, repo);
    const edited = fitBody(text.trim());
    try {
      await this.client.send(chat, edited, { agent: repo, re: noteId });
    } catch (error) {
      this.drafts.set(chat, [{ ...draft, text: edited }, ...(this.drafts.get(chat) ?? [])]); // Put it back as edited, so nothing the user or their agent wrote is lost.
      this.hooks.changed();
      throw error;
    }
  }

  private async discardDraft(chat: string, noteId: number, repo: string): Promise<void> {
    const draft = this.takeDraft(chat, noteId, repo);
    await this.report(chat, draft.entry, repo, "declined");
  }

  private runRequest(noteId: number, repo: string, post: boolean): void {
    const entry = this.chats.find(noteId);
    if (entry !== null && this.chats.requests(entry, this.client.now()).some((request) => request.owner === this.me && request.repo === repo)) {
      this.startRun(entry, repo, post);
    }
  }

  private async decline(noteId: number, repo: string): Promise<void> {
    const entry = this.chats.find(noteId);
    if (entry !== null) {
      await this.report(chatOf(entry.note, this.me), entry, repo, "declined");
    }
  }

  private async joinChannel(name: string): Promise<void> {
    const bare = nameSchema.safeParse(name.trim().replace(/^#/, ""));
    if (!bare.success) {
      throw new PlayerTwoError("a channel's name is lowercase letters, digits, - and _, at most 32 characters");
    }
    const channel = (await this.client.joinChannel(bare.data)).name;
    this.sync(await this.snapshot(null), true); // A channel's earlier notes are older than the poll's cursor, so load them now.
    this.open(channel);
  }

  private async leaveChannel(chat: string): Promise<void> {
    if (!isChannel(chat)) {
      return;
    }
    await this.client.leaveChannel(chat);
    this.channels = await this.client.channels();
    this.chats.forget(chat);
    this.drafts.delete(chat);
    if (this.current === chat) {
      this.current = "";
      const first = this.rows()[0];
      if (first !== undefined) {
        this.open(first.chat);
      }
    }
    this.hooks.notice({ title: "", body: `You left ${chat}.`, severity: "info" });
    this.hooks.changed();
  }

  private async pin(chat: string, repo: string): Promise<void> {
    const checkout = this.checkouts.get(repo);
    if (checkout === undefined) {
      throw new PlayerTwoError(`you have no checkout of ${repo} to pin`);
    }
    this.setChannel(await this.client.pin(chat, checkout.remote));
  }

  private setChannel(info: ChannelInfo): void {
    this.channels = [...this.channels.filter((other) => other.name !== info.name), info];
    this.hooks.changed();
  }

  /** Offer to clone a repo the user lacks into ~/dev, showing where it comes from before anything is fetched. */
  private async clone(repo: string): Promise<void> {
    const pinned = this.channels.find((channel) => channel.name === this.current)?.repo ?? null;
    const known: readonly RepoRef[] = [...this.team.map(refOf), ...(pinned === null ? [] : [pinned])];
    const ref = known.find((candidate) => candidate.name === repo);
    if (this.checkouts.has(repo)) {
      throw new PlayerTwoError(`you already have ${repo}`);
    }
    if (ref === undefined) {
      throw new PlayerTwoError(`nobody on this hub has ${repo}, so there is nowhere to clone it from`);
    }
    const destination = joinPath(this.dev, decodeURIComponent(ref.url.replace(/\/+$/, "").split("/").at(-1) ?? repo));
    if (!(await this.hooks.confirmClone(ref.url, destination))) {
      return;
    }
    this.hooks.notice({ title: "", body: `Cloning ${repo}…`, severity: "info" });
    await this.cloner(ref.url, destination);
    await this.share();
    this.hooks.notice({ title: "", body: `Cloned ${repo} into ${destination}. Your ${repo} agent can be tagged now.`, severity: "info" });
  }

  // ── running an agent ──────────────────────────────────────────────────────

  private startRun(entry: Entry, repo: string, post: boolean): void {
    const checkout = this.checkouts.get(repo);
    const key = runKey(entry.id, repo);
    if (this.runs.has(key)) {
      return;
    }
    if (checkout === undefined) {
      throw new PlayerTwoError(`there is no checkout of ${repo} under ${this.dev}`);
    }
    const argv = [...splitCommand(this.client.config.agent), agentPrompt(entry, this.me, repo, this.chats.earlier(entry), !post)];
    const run: AgentRun = { entry, repo, post, cancel: new AbortController(), startedAt: Date.now(), done: Promise.resolve() };
    this.runs.set(key, run);
    run.done = this.work(key, run, checkout, argv);
    this.hooks.changed();
  }

  /** Run the agent and see its answer to where it belongs. Never rejects: every way a run can end is told to the chat and to the user. */
  private async work(key: string, run: AgentRun, checkout: Checkout, argv: readonly string[]): Promise<void> {
    const { entry, repo } = run;
    const chat = chatOf(entry.note, this.me);
    let ending = "";
    try {
      await this.report(chat, entry, repo, `working\n${await this.describe(checkout)}`);
      const text = fitBody(await this.runner(argv, checkout.path, run.cancel.signal));
      if (text === "") {
        ending = "the agent returned nothing";
      } else if (run.post) {
        await this.postAnswer(chat, { text, entry, repo });
      } else {
        this.queueDraft(chat, { text, entry, repo });
      }
    } catch (error) {
      ending = error instanceof AgentCancelledError ? "stopped" : problemOf(error);
    }
    if (ending === "stopped") {
      await this.report(chat, entry, repo, "stopped");
      this.hooks.notice({ title: "", body: `Stopped your ${repo} agent.`, severity: "info" });
    } else if (ending !== "") {
      await this.report(chat, entry, repo, "failed"); // Only the fact: what the agent printed on the way down may not be fit to share.
      this.hooks.notice({ title: `your ${repo} agent`, body: ending, severity: "error" });
    }
    this.runs.delete(key);
    this.hooks.changed();
  }

  private async postAnswer(chat: string, draft: Draft): Promise<void> {
    try {
      await this.client.send(chat, draft.text, { agent: draft.repo, re: draft.entry.id });
    } catch (error) {
      // An answer that could not be posted is kept as a draft, so the agent's work is not lost.
      this.hooks.notice({ title: `your ${draft.repo} agent's answer was not posted; it is kept as a draft`, body: problemOf(error), severity: "error" });
      this.queueDraft(chat, draft);
    }
  }

  private queueDraft(chat: string, draft: Draft): void {
    this.drafts.set(chat, [...(this.drafts.get(chat) ?? []), draft]);
    this.hooks.arrived({ chat, title: `Your ${draft.repo} agent's draft is ready to review`, body: oneLine(draft.text, 120), forMe: true, rings: true });
  }

  /** Tell everyone in the chat what an agent is doing with a note. Best effort: the note itself is what matters. */
  private async report(chat: string, entry: Entry, repo: string, state: string): Promise<void> {
    try {
      await this.client.send(chat, state, { kind: "status", agent: repo, re: entry.id });
    } catch {
      // The chat misses one status line.
    }
  }
}
