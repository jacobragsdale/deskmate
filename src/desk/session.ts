/** One person's Player Two session: follows the hub, shares their repos, runs their agents when they say so, and keeps what the window shows. No window code. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

import { z } from "zod";

import type { Arrival, ChatView, Command, CurrentView, MessageView, Notice, RequestView, RowView } from "../shared/ipc.ts";
import { agentPrompt, ChatLog, chatOf, continues, mentions, ONLINE, refOf, rings } from "../core/chat.ts";
import type { Accepted, Entry, Message, Request } from "../core/chat.ts";
import { readContent } from "../core/kinds.ts";
import { runAgent, splitCommand } from "./agents/oneshot.ts";
import { AgentCancelledError, PlayerTwoError } from "./client.ts";
import type { Client, Runner } from "./client.ts";
import * as repos from "./repos.ts";
import type { Checkout, Head } from "./repos.ts";
import { cloneFolder } from "../core/remotes.ts";
import { oneLine, problemOf } from "../core/text.ts";
import { fitText, isChannel, nameSchema, PROTOCOL } from "../core/wire.ts";
import type { ChannelInfo, Delivered, Person, RepoRef, TeamRepo } from "../core/wire.ts";

const PRESENCE = 25; // Seconds between asking the hub who is here, which channels there are and who has which repo. Each is a signed request, which is what says the user is here; the repo scan runs on the same beat.
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
  readonly describe?: (checkout: Checkout) => Promise<Head>;
  readonly presence?: number; // Seconds between presence checks; a test shortens it.
}

/** An agent's answer waiting for its owner to review, edit and send. */
interface Draft {
  readonly text: string;
  readonly entry: Entry; // The request it answers.
  readonly repo: string; // The repo the agent worked in.
  readonly branch: string; // The branch it worked on.
}

interface AgentRun {
  readonly entry: Entry; // The request.
  readonly repo: string;
  readonly post: boolean; // Post the answer as soon as it is ready, rather than drafting it for review.
  readonly cancel: AbortController;
  readonly startedAt: number; // Unix milliseconds.
  done: Promise<void>; // Settles once the agent's process is gone and the chat has been told how it ended.
}

type ChatCommand = Exclude<Command, { do: "join" | "doctor" }>;

/** The hub speaks another protocol: asked again only after UPDATE_DELAY. */
class ProtocolError extends PlayerTwoError {}

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

function runKey(request: string, repo: string): string {
  return `${request} ${repo}`;
}

function dayOf(ts: number): string {
  return new Date(ts * 1000).toDateString();
}

/** The branch a run was let go ahead on, marked ± when the checkout had changes nobody had committed; "" when it never was. */
function ranOn(accepted: Accepted | null): string {
  return accepted === null ? "" : `${accepted.branch}${accepted.dirty ? " ±" : ""}`;
}

/** What a message or an answer says; "" for anything else. */
function textOf(entry: Entry): string {
  const said = readContent(entry.event);
  return said.kind === "message" || said.kind === "job.result" ? said.content.text : "";
}

export class Session {
  private readonly client: Client;
  private readonly dev: string;
  private readonly hooks: Hooks;
  private readonly runner: Runner;
  private readonly cloner: (url: string, destination: string) => Promise<void>;
  private readonly describe: (checkout: Checkout) => Promise<Head>;
  private readonly presence: number;
  private readonly me: string;
  private readonly chats: ChatLog;
  private readonly stopping = new AbortController();
  private readonly drafts = new Map<string, Draft[]>(); // Per chat, answers waiting for review, oldest first.
  private readonly runs = new Map<string, AgentRun>(); // By request and repo.
  private readonly autorun = new Set<string>(); // Messages just sent from here: their tags of the user's own agents run without asking.
  private readonly read: Record<string, number>; // Per chat, the seq of the newest event the user has seen.
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
  private attentive = true; // Whether the user is looking at the window. Messages that arrive while they are not stay unread.
  private following: Promise<void> = Promise.resolve();
  private streaming: Promise<void> | null = null; // The hub's stream, followed once what was there before it has been loaded.

  constructor(client: Client, dev: string, hooks: Hooks, options: Options = {}) {
    this.client = client;
    this.dev = dev;
    this.hooks = hooks;
    this.runner = options.runner ?? runAgent;
    this.cloner = options.cloner ?? repos.clone;
    this.describe = options.describe ?? repos.describe;
    this.presence = options.presence ?? PRESENCE;
    this.me = client.config.name;
    this.chats = new ChatLog(this.me);
    const saved = this.loadSaved();
    this.read = { ...saved.read };
    this.lastChat = saved.chat;
  }

  public start(): void {
    this.following = this.follow();
  }

  /** Stop following the hub and stop every agent still working, waiting briefly so each is gone and the chat has been told. */
  public async stop(): Promise<void> {
    this.stopping.abort();
    const runs = [...this.runs.values()];
    for (const run of runs) {
      run.cancel.abort();
    }
    const settled = new AbortController();
    await Promise.race([Promise.all([this.following, this.streaming, ...runs.map((run) => run.done)]), sleep(STOP_WAIT, settled.signal)]);
    settled.abort(); // Take the timer down with it, so a desk that has stopped is free to exit at once.
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
        await this.sendDraft(command.chat, command.id, command.repo, command.text);
        break;
      case "discardDraft":
        await this.discardDraft(command.chat, command.id, command.repo);
        break;
      case "run":
        this.runRequest(command.id, command.repo, command.post);
        break;
      case "stop":
        this.runs.get(runKey(command.id, command.repo))?.cancel.abort();
        break;
      case "decline":
        await this.decline(command.id, command.repo);
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
    const working = new Set([...this.runs.values()].map((run) => chatOf(run.entry.event, this.me)));
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
      drafts: (this.drafts.get(chat) ?? []).map((draft) => ({ id: draft.entry.event.id, repo: draft.repo, asker: draft.entry.event.author, text: draft.text })),
      running: [...this.runs.values()].some((run) => chatOf(run.entry.event, this.me) === chat)
    };
  }

  private messages(chat: string, now: number): MessageView[] {
    const messages: MessageView[] = [];
    let previous: Message | null = null;
    let marked = false;
    // ponytail: every message of the open chat is sent to the window on each change. Send only what is new if long chats make it slow.
    for (const item of this.chats.items(chat)) {
      if (item.kind === "line") {
        continue;
      }
      const { seq, event } = item.kind === "message" ? item.message.entry : item.entry;
      const firstNew: boolean = !marked && this.newAfter !== null && seq > this.newAfter && event.author !== this.me;
      marked ||= firstNew;
      if (firstNew || (previous !== null && dayOf(previous.entry.event.ts) !== dayOf(event.ts))) {
        previous = null; // The first message of a day, and the first after the "new" line, says who wrote it.
      }
      messages.push(item.kind === "message" ? this.messageView(item.message, previous, now) : this.warningView(item.entry));
      previous = item.kind === "message" ? item.message : null;
    }
    return messages;
  }

  private messageView(message: Message, previous: Message | null, now: number): MessageView {
    const { seq, event } = message.entry;
    const answered = message.answers === null ? null : this.chats.message(message.answers);
    return {
      id: event.id,
      seq,
      sender: event.author,
      agent: message.agent,
      branch: this.branchOf(message, now),
      ts: event.ts,
      trusted: true,
      body: message.text,
      quote: answered === null ? "" : `${answered.entry.event.author}: ${oneLine(answered.text)}`,
      header: !continues(previous, message),
      requests: this.chats.requests(message, now).flatMap((request) => this.requestView(request))
    };
  }

  /** An event whose signature failed: who it claims to be from and when, and never what it says. */
  private warningView({ seq, event }: Entry): MessageView {
    return { id: event.id, seq, sender: event.author, agent: null, branch: "", ts: event.ts, trusted: false, body: "", quote: "", header: true, requests: [] };
  }

  /** The branch an answer was written on: as its owner accepted the run when the request is here, and as the answer says when it is not. */
  private branchOf(message: Message, now: number): string {
    const request = message.answers === null ? null : this.chats.message(message.answers);
    const job = request === null ? undefined : this.chats.requests(request, now).find((each) => each.owner === message.entry.event.author && each.repo === message.agent);
    return job === undefined || job.accepted === null ? message.branch : ranOn(job.accepted);
  }

  /** Where one tagged agent stands: for the user's own, what they can do; for a teammate's, how far it has got. Nothing once it is answered. */
  private requestView(request: Request): RequestView[] {
    const { owner, repo } = request;
    const mine = owner === this.me;
    return request.state === "answered" ? [] : [{ id: request.message.entry.event.id, owner, repo, mine, status: mine ? this.myStatus(request) : this.theirStatus(request) }];
  }

  private myStatus(request: Request): RequestView["status"] {
    const { repo, state } = request;
    const { event } = request.message.entry;
    const run = this.runs.get(runKey(event.id, repo));
    if ((this.drafts.get(chatOf(event, this.me)) ?? []).some((draft) => draft.entry.event.id === event.id && draft.repo === repo)) {
      return { kind: "drafted" };
    }
    if (run !== undefined) {
      return { kind: "running", startedAt: run.startedAt, branch: ranOn(request.accepted) };
    }
    if (state === "withdrawn") {
      return { kind: "withdrawn" };
    }
    if (!this.checkouts.has(repo)) {
      return { kind: "noCheckout" };
    }
    const before = state === "working" ? "interrupted" : state === "waiting" || state === "answered" ? "" : state;
    return { kind: "ready", before, canDecline: event.author !== this.me && state !== "declined" };
  }

  private theirStatus(request: Request): RequestView["status"] {
    const { owner, repo, state } = request;
    if (state === "working") {
      return { kind: "working", branch: ranOn(request.accepted) };
    }
    if (state === "declined" || state === "failed" || state === "stopped" || state === "withdrawn") {
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

  /**
   * Make sure the hub speaks this protocol, load what is there, then follow the hub's stream, which opens itself again whenever it drops.
   * Meanwhile, every PRESENCE seconds, share the user's repos and ask who is here, which channels there are and who has which repo.
   */
  private async follow(): Promise<void> {
    const stopped = (): boolean => this.stopping.signal.aborted; // Asked afresh each time: it changes while this waits.
    let greeted = false; // Whether the hub has said it speaks this protocol since it last failed to answer.
    while (!stopped()) {
      let wait = this.presence;
      try {
        if (!greeted) {
          await this.greet();
          greeted = true;
        }
        await this.share();
        await this.refresh();
        if (this.streaming === null) {
          const after = await this.load();
          this.streaming = this.client.stream(after, (batch) => this.arrive(batch), this.stopping.signal);
        }
      } catch (error) {
        if (stopped()) {
          return;
        }
        wait = error instanceof ProtocolError ? UPDATE_DELAY : RETRY_DELAY;
        greeted = false;
        this.connected = false;
        this.problem = problemOf(error);
        this.hooks.changed();
      }
      await sleep(wait, this.stopping.signal);
    }
  }

  private async greet(): Promise<void> {
    const info = await this.client.info();
    if (info.protocol !== PROTOCOL) {
      throw new ProtocolError(`the hub speaks protocol ${String(info.protocol)} and this app speaks protocol ${String(PROTOCOL)}: update the ${info.protocol > PROTOCOL ? "app" : "hub"}`);
    }
    this.prefix = info.repos;
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

  /** Ask who is here, which channels there are and who has which repo. */
  private async refresh(): Promise<void> {
    const [people, channels, team] = await Promise.all([this.client.users(), this.client.channels(), this.client.repos()]);
    this.people = people;
    this.channels = channels;
    this.team = team;
    this.connected = true;
    this.problem = "";
    this.openFirst();
    this.hooks.changed();
  }

  /** Load everything there is to see, and return the seq the stream is to follow on from. */
  private async load(): Promise<number> {
    const found = await this.client.catchUp(0);
    this.take(await this.trust(found), false);
    this.loaded = true;
    this.hooks.changed();
    return found.at(-1)?.seq ?? 0;
  }

  /** What the stream has just delivered. Should this fail, the stream delivers it again. */
  private async arrive(batch: readonly Delivered[]): Promise<void> {
    this.take(await this.trust(batch), true);
  }

  private async trust(found: readonly Delivered[]): Promise<Entry[]> {
    const entries: Entry[] = [];
    for (const delivered of found) {
      entries.push({ ...delivered, trusted: await this.client.isTrusted(delivered.event) });
    }
    return entries;
  }

  private take(entries: readonly Entry[], announce: boolean): void {
    const fresh = this.chats.add(entries);
    for (const entry of fresh) {
      if (this.autorun.has(entry.event.id)) {
        this.runOwnTags(entry);
      }
    }
    this.openFirst();
    if (announce) {
      this.announce(fresh.filter((entry) => (entry.event.kind === "message" || entry.event.kind === "job.result") && entry.event.author !== this.me));
    }
    this.markRead();
    this.hooks.changed();
  }

  /** Open a chat when none is open: where something is waiting, failing that where the user left off, failing that the first. */
  private openFirst(): void {
    if (this.current === "") {
      const rows = this.rows();
      const start = rows.find((row) => row.unread > 0) ?? rows.find((row) => row.chat === this.lastChat) ?? rows[0];
      if (start !== undefined) {
        this.open(start.chat);
      }
    }
  }

  private announce(incoming: readonly Entry[]): void {
    for (const entry of incoming.slice(-3)) {
      const { event } = entry;
      const text = textOf(entry);
      const tagged = entry.trusted && event.kind === "message" ? mentions(text).filter(([owner]) => owner === this.me) : [];
      const where = isChannel(event.to) ? ` in ${event.to}` : "";
      const title = tagged[0] === undefined ? `${event.author}${where}` : `${event.author} tagged your ${tagged[0][1]} agent${where}`;
      this.hooks.arrived({
        chat: chatOf(event, this.me),
        title,
        body: entry.trusted ? oneLine(text, 120) : "a message failed its signature check",
        forMe: tagged.length > 0,
        rings: rings(entry, this.me)
      });
    }
  }

  private markRead(): void {
    if (this.current === "" || !this.attentive) {
      return;
    }
    const newest = this.chats.bounds(this.current)?.newest ?? 0;
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
    const body = fitText(text.trim());
    if (body === "") {
      return;
    }
    // A message typed here runs its tags of the user's own agents without asking, once it has come back from the hub.
    const sent = await this.client.publish(chat, "message", { text: body, via: "window" });
    this.autorun.add(sent.event.id);
    const found = this.chats.message(sent.event.id);
    if (found !== null) {
      this.runOwnTags(found.entry);
    }
  }

  private runOwnTags(entry: Entry): void {
    this.autorun.delete(entry.event.id);
    const message = this.chats.message(entry.event.id);
    if (entry.event.author !== this.me || message === null) {
      return;
    }
    for (const request of this.chats.requests(message, this.client.now())) {
      if (request.owner === this.me && request.state === "waiting" && this.checkouts.has(request.repo)) {
        this.startRun(message, request.repo, true);
      }
    }
  }

  private takeDraft(chat: string, request: string, repo: string): Draft {
    const drafts = this.drafts.get(chat) ?? [];
    const draft = drafts.find((candidate) => candidate.entry.event.id === request && candidate.repo === repo);
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

  private async sendDraft(chat: string, request: string, repo: string, text: string): Promise<void> {
    const draft = this.takeDraft(chat, request, repo);
    const edited = fitText(text.trim());
    try {
      await this.client.publish(chat, "job.result", { repo, branch: draft.branch, text: edited, reviewed: true }, [request]);
    } catch (error) {
      this.drafts.set(chat, [{ ...draft, text: edited }, ...(this.drafts.get(chat) ?? [])]); // Put it back as edited, so nothing the user or their agent wrote is lost.
      this.hooks.changed();
      throw error;
    }
  }

  private async discardDraft(chat: string, request: string, repo: string): Promise<void> {
    this.takeDraft(chat, request, repo);
    await this.decline(request, repo);
  }

  private runRequest(request: string, repo: string, post: boolean): void {
    const message = this.chats.message(request);
    if (message !== null && this.chats.requests(message, this.client.now()).some((each) => each.owner === this.me && each.repo === repo && each.state !== "withdrawn")) {
      this.startRun(message, repo, post);
    }
  }

  /** Say no to a request for one of the user's agents. Best effort: the chat misses one line. */
  private async decline(request: string, repo: string): Promise<void> {
    const message = this.chats.message(request);
    if (message !== null) {
      await this.client.publish(chatOf(message.entry.event, this.me), "job.declined", { repo, reason: "" }, [request]).catch(() => undefined);
    }
  }

  private async joinChannel(name: string): Promise<void> {
    const bare = nameSchema.safeParse(name.trim().replace(/^#/, ""));
    if (!bare.success) {
      throw new PlayerTwoError("a channel's name is lowercase letters, digits, - and _, at most 32 characters");
    }
    const channel = (await this.client.joinChannel(bare.data)).name;
    this.channels = await this.client.channels();
    this.take(await this.trust(await this.client.events({ chat: channel })), false); // A channel's earlier events are behind the stream's place in the log, so they are loaded here.
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
    const folder = cloneFolder(ref.url);
    if (folder === null) {
      throw new PlayerTwoError(`${ref.url} does not end in a folder name to clone ${repo} into`);
    }
    const destination = joinPath(this.dev, folder);
    if (!(await this.hooks.confirmClone(ref.url, destination))) {
      return;
    }
    this.hooks.notice({ title: "", body: `Cloning ${repo}…`, severity: "info" });
    await this.cloner(ref.url, destination);
    await this.share();
    this.hooks.notice({ title: "", body: `Cloned ${repo} into ${destination}. Your ${repo} agent can be tagged now.`, severity: "info" });
  }

  // ── running an agent ──────────────────────────────────────────────────────

  private startRun(message: Message, repo: string, post: boolean): void {
    const checkout = this.checkouts.get(repo);
    const key = runKey(message.entry.event.id, repo);
    if (this.runs.has(key)) {
      return;
    }
    if (checkout === undefined) {
      throw new PlayerTwoError(`there is no checkout of ${repo} under ${this.dev}`);
    }
    const argv = [...splitCommand(this.client.config.agent), agentPrompt(message, this.me, repo, this.chats.earlier(message), !post)];
    const run: AgentRun = { entry: message.entry, repo, post, cancel: new AbortController(), startedAt: Date.now(), done: Promise.resolve() };
    this.runs.set(key, run);
    run.done = this.work(key, run, checkout, argv);
    this.hooks.changed();
  }

  /**
   * Tell the chat the user let the agent run, on which branch and commit, then run it and see its answer to where it belongs. Never rejects: every way a run can end is told to the user.
   * Nothing runs until the chat has been told: when that cannot be published, the agent does not start. Once it has, the chat hears one ending: the answer (now, or when the draft is sent, or a decline when it is thrown away), a failure, or a stop.
   */
  private async work(key: string, run: AgentRun, checkout: Checkout, argv: readonly string[]): Promise<void> {
    const { entry, repo } = run;
    const chat = chatOf(entry.event, this.me);
    const request = [entry.event.id];
    let head: Head;
    try {
      head = await this.describe(checkout);
      await this.client.publish(chat, "job.accepted", { repo, ...head, delivery: run.post ? "post" : "review", mode: "full", by: "owner" }, request);
    } catch (error) {
      this.hooks.notice({ title: `your ${repo} agent did not start`, body: problemOf(error), severity: "error" });
      this.runs.delete(key);
      this.hooks.changed();
      return;
    }
    let ending = "";
    try {
      const text = fitText(await this.runner(argv, checkout.path, run.cancel.signal));
      if (text === "") {
        ending = "the agent returned nothing";
      } else if (run.post) {
        await this.postAnswer(chat, { text, entry, repo, branch: head.branch });
      } else {
        this.queueDraft(chat, { text, entry, repo, branch: head.branch });
      }
    } catch (error) {
      ending = error instanceof AgentCancelledError ? "stopped" : problemOf(error);
    }
    if (ending === "stopped") {
      await this.client.publish(chat, "job.cancelled", { repo }, request).catch(() => undefined);
      this.hooks.notice({ title: "", body: `Stopped your ${repo} agent.`, severity: "info" });
    } else if (ending !== "") {
      await this.client.publish(chat, "job.error", { repo }, request).catch(() => undefined); // Only the fact: what the agent printed on the way down may not be fit to share.
      this.hooks.notice({ title: `your ${repo} agent`, body: ending, severity: "error" });
    }
    this.runs.delete(key);
    this.hooks.changed();
  }

  private async postAnswer(chat: string, draft: Draft): Promise<void> {
    try {
      await this.client.publish(chat, "job.result", { repo: draft.repo, branch: draft.branch, text: draft.text, reviewed: false }, [draft.entry.event.id]);
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
}
