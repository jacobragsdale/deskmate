/** One person's Player Two session: follows the hub, shares their repos, runs their agents when they say so, and keeps what the window shows. No window code. */

import { createHash } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

import { z } from "zod";

import { runOf } from "../shared/ipc.ts";
import type {
  ActivityItem,
  Arrival,
  AskView,
  ChatView,
  Check,
  Command,
  CurrentView,
  GrantView,
  Hit,
  LineView,
  MessageView,
  NoteView,
  Notice,
  PatchView,
  ReplyView,
  Question,
  RequestView,
  RowView
} from "../shared/ipc.ts";
import { agentPrompt, ChatLog, chatOf, continues, mayCome, mentions, ONLINE, refOf, rings } from "../core/chat.ts";
import type { Accepted, Delegation, Entry, Message, PatchContent, Request } from "../core/chat.ts";
import { checkRequest, jobIn, peopleInvolved, ROOT_TIME } from "../core/delegation.ts";
import { makesExecutable, modeOf, parseDiff, touchesInstructions, unsafePaths } from "../core/diff.ts";
import type { Node } from "../core/delegation.ts";
import { DAY, liveGrant, revoked, standing } from "../core/grants.ts";
import type { Standing } from "../core/grants.ts";
import { readContent } from "../core/kinds.ts";
import { notesIn } from "../core/links.ts";
import { roomName, suggestions } from "../core/rooms.ts";
import type { Room } from "../core/rooms.ts";
import type { Content, ContentOf, Summary } from "../core/kinds.ts";
import { publicHex } from "../core/sign.ts";
import { acpRunner, greet } from "./agents/acp.ts";
import { agentEnv, agentKey, keyIn } from "./agentKeys.ts";
import { endedItem, startedItem } from "./agents/activity.ts";
import { AGENT_TIMEOUT, oneshotRunner, runAgent } from "./agents/oneshot.ts";
import { PRESETS } from "./agents/presets.ts";
import type { AgentRunner, FollowUp, Pausable, PermissionAsk, RunHandlers } from "./agents/runner.ts";
import { AgentCancelledError, AgentTimedOutError, PlayerTwoError, Refused } from "./client.ts";
import type { Client, Found, Runner } from "./client.ts";
import { ACP_TIMEOUT, permissionTests, testPermissions } from "./doctor.ts";
import type { Tested } from "./doctor.ts";
import { atMost } from "./permissions.ts";
import * as repos from "./repos.ts";
import type { Checkout, Head } from "./repos.ts";
import * as patches from "./patches.ts";
import { listed, named, plain } from "./patches.ts";
import * as worktree from "./worktree.ts";
import type { Worktree } from "./worktree.ts";
import { cloneFolder } from "../core/remotes.ts";
import { byCodeUnit, oneLine, problemOf } from "../core/text.ts";
import { commandLineOf, defaultAgentOf, fitText, isAgent, isChannel, MAX_PATCH, MAX_SKEW, MODES, nameSchema, ownerOf, permissionModeSchema, PROTOCOL } from "../core/wire.ts";
import type { Agent, ChannelInfo, Delivered, Event, PermissionMode, Person, RepoRef, TeamRepo } from "../core/wire.ts";

const PRESENCE = 25; // Seconds between asking the hub who is here, which channels there are and who has which repo. Each is a signed request, which is what says the user is here; the repo scan runs on the same beat.
const RETRY_DELAY = 5; // Seconds to wait before asking a hub that did not answer again.
const UPDATE_DELAY = 60; // Seconds to wait before asking a hub on another protocol again: its answer changes only when someone updates one side.
const STOP_WAIT = 3; // Seconds to give stopped agents to go before the session is done.
const PAGE = 50; // Events of one chat loaded at a time: its newest when it is first listed, and as many again each time the user scrolls back.
const PROGRESS = 10; // Least seconds between two job.progress events of one run.
const HEARTBEAT = 300; // Seconds after which the chat is told again what a run is doing, unchanged, so that teammates go on believing it works: well within STALE, which a run waiting on its owner may outlast.
const ITEMS = 500; // Items of one run's activity kept, the newest.
const FEEDS = 20; // Runs that have ended whose activity is kept, the newest.
const EVERYONE = 200; // Events to everyone read at a time when the desk starts: the most the hub gives at once.

/**
 * How the user last ran a request: at which mode, whether its answer was posted without a review, and the agent that answered, by its id and command line.
 * A choice kept before the agent was has none, and so matches no agent.
 */
const choiceSchema = z.strictObject({ mode: permissionModeSchema, post: z.boolean(), agent: z.strictObject({ id: z.string(), line: z.string() }).optional() });

/**
 * What the session remembers between runs, in app-state.json: read marks, the chat open last, how each asker's requests of each repo were last run, by the asker and the repo,
 * and the branch rooms the user said not to suggest (phase 6).
 */
const savedSchema = z.strictObject({
  read: z.record(z.string(), z.int()),
  chat: z.string().nullable(),
  choices: z.record(z.string(), choiceSchema).default({}),
  dismissed: z
    .array(z.strictObject({ repo: z.string(), branch: z.string() }).readonly())
    .readonly()
    .default([])
});

type Offer = Extract<RequestView["status"], { kind: "ready" }>["offer"];

const FIRST_CHOICE: Offer = { mode: "read-only", post: false }; // What a request is offered at until its asker's requests of that repo have been run: the least an agent may do, reviewed.

export interface Hooks {
  readonly changed: () => void; // What `view()` returns is different now.
  readonly notice: (notice: Notice) => void;
  readonly arrived: (arrival: Arrival) => void;
  readonly confirmClone: (url: string, destination: string) => Promise<boolean>; // Show where a clone comes from and goes to, before anything is fetched.
  readonly confirm?: (question: Question) => Promise<boolean>; // Put a yes or no to the user in a dialog of the system's own, as before a patch is applied. Without it, as for a desk no window asks for, the answer is no.
}

export interface Options {
  readonly runner?: Runner;
  readonly cloner?: (url: string, destination: string) => Promise<void>;
  readonly describe?: (checkout: Checkout) => Promise<Head>;
  readonly presence?: number; // Seconds between presence checks; a test shortens it.
  readonly progress?: number; // Least seconds between two job.progress events of one run; a test shortens it.
  readonly heartbeat?: number; // Seconds after which an unchanged job.progress is sent again; a test shortens it.
  readonly limit?: number; // Seconds of its own a run over ACP may take; a test shortens it.
  readonly rootTime?: number; // Seconds after its owner let it go that a run let ask other agents on a person's request is stopped, with everything under it; a test shortens it.
}

/** An agent's answer waiting for its owner to review, edit and send. */
interface Draft {
  readonly text: string;
  readonly entry: Entry; // The request it answers.
  readonly repo: string; // The repo the agent worked in.
  readonly branch: string; // The branch it worked on.
  readonly patch: ContentOf<"patch"> | null; // What its run on a clean copy changed, sent with it, before it; null when it changed nothing, or ran in the checkout.
}

/** An agent's ask waiting for its owner's answer. */
interface Waiting {
  readonly run: string; // The run's key.
  readonly chat: string;
  readonly ask: PermissionAsk;
  readonly answer: (answer: Answer) => void;
}

type Answer = Awaited<ReturnType<RunHandlers["permission"]>>;

interface AgentRun {
  readonly entry: Entry; // The request.
  readonly repo: string;
  readonly post: boolean; // Post the answer as soon as it is ready, rather than drafting it for review.
  readonly mode: PermissionMode; // What the agent may do without asking, as job.accepted says.
  readonly agent: string; // The label of the agent that runs it.
  readonly grant: string | null; // The id of the grant it runs under; null when its owner let it run themselves.
  readonly delegate: boolean; // Whether its owner let the agent ask other agents in it: never under a grant, and only over ACP.
  readonly copy: boolean; // Whether it runs on a clean copy of the checkout, a worktree, rather than in it: a teammate's request let do more than read.
  accepting: boolean; // Until the chat is told it runs, or it ends before: a run under a grant counts against its daily limit before the log holds its acceptance.
  readonly cancel: AbortController;
  readonly startedAt: number; // Unix milliseconds.
  done: Promise<void>; // Settles once the agent's process is gone and the chat has been told how it ended.
  doing: Summary | ""; // What the agent is doing now, in job.progress's words; "" until it has said.
  told: Summary | ""; // What the chat was last told it is doing.
  clock: Pausable | null; // Its time limit, once its runner has started it, which stands still while an agent it asked is at work; null for a runner without one.
  held: boolean; // Whether its time limit stands still for that.
  toldAt: number; // When, Unix milliseconds; 0 before it ever was.
  telling: NodeJS.Timeout | undefined; // Set while the chat is to be told: once PROGRESS seconds have passed since it last was, or HEARTBEAT.
  tellAt: number; // When it is to be told, Unix milliseconds.
}

type ChatCommand = Exclude<Command, { do: "join" | "doctor" | "search" | "testPermissions" | "saveAzureToken" }>;
type MessageDo = "send" | "reply" | "react" | "edit" | "delete" | "applyPatch" | "review"; // What the user does to a message: a patch's among them.
type JobDo = "sendDraft" | "discardDraft" | "run" | "stop" | "stopAll" | "permit" | "decline" | "withdraw" | "grant" | "revoke";

const MESSAGE_DOS: ReadonlySet<string> = new Set<MessageDo>(["send", "reply", "react", "edit", "delete", "applyPatch", "review"]);
const JOB_DOS: ReadonlySet<string> = new Set<JobDo>(["sendDraft", "discardDraft", "run", "stop", "stopAll", "permit", "decline", "withdraw", "grant", "revoke"]);
type RoomDo = "pin" | "unpin" | "startRoom" | "dismissRoom";
const ROOM_DOS: ReadonlySet<string> = new Set<RoomDo>(["pin", "unpin", "startRoom", "dismissRoom"]);

function isAboutMessages(command: ChatCommand): command is Extract<ChatCommand, { readonly do: MessageDo }> {
  return MESSAGE_DOS.has(command.do);
}

function isAboutJobs(command: ChatCommand): command is Extract<ChatCommand, { readonly do: JobDo }> {
  return JOB_DOS.has(command.do);
}

function isAboutRooms(command: ChatCommand): command is Extract<ChatCommand, { readonly do: RoomDo }> {
  return ROOM_DOS.has(command.do);
}

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

function dayOf(ts: number): string {
  return new Date(ts * 1000).toDateString();
}

/** The branch a run was let go ahead on, marked ± when the checkout had changes nobody had committed; "" when it never was. */
function ranOn(accepted: Accepted | null): string {
  return accepted === null ? "" : `${accepted.branch}${accepted.dirty ? " ±" : ""}`;
}

/** How a run that threw ended, as its owner's feed says it: stopped, out of time, or failed and why. */
function endedBy(error: unknown): ActivityItem {
  if (error instanceof AgentCancelledError) {
    return endedItem("stopped");
  }
  return endedItem(error instanceof AgentTimedOutError ? "timed out" : "failed", problemOf(error));
}

/** What a message, an answer or an agent's request of another says; "" for anything else. */
function textOf(entry: Entry): string {
  const said = readContent(entry.event);
  return said.kind === "message" || said.kind === "job.result" || said.kind === "job.request" ? said.content.text : "";
}

/** An agent, "owner/repo", as the user reads of it: "your billing agent", or "jacob's uploader agent". */
function agentWords(agent: string, me: string): string {
  const owner = ownerOf(agent);
  return `${owner === me ? "your" : `${owner}'s`} ${agent.slice(owner.length + 1)} agent`;
}

/**
 * Who an arrival is from, as its title says: a person; for an answer nobody reviewed, its owner, saying so, as its header does, since it is the one its agent signed, `owner/repo`;
 * and for an agent's request of another, the agent.
 */
function fromWords(event: Event, me: string): string {
  if (event.kind === "job.request") {
    return agentWords(event.author, me);
  }
  return `${ownerOf(event.author)}${event.kind === "job.result" && isAgent(event.author) ? ` (${event.author.slice(ownerOf(event.author).length + 1)} agent, not reviewed)` : ""}`;
}

/** Where an agent's request of another came from, in words for the user: "bob asked jacob's uploader agent, which is asking your billing agent". */
function chainWords({ first, chain, target }: Delegation, me: string): string {
  const [head = "", ...rest] = chain;
  const asker = first === "" ? "someone" : first === me ? "you" : first;
  return [`${asker} asked ${agentWords(head, me)}`, ...rest.map((agent) => `which asked ${agentWords(agent, me)}`), `which is asking ${agentWords(target, me)}`].join(", ");
}

/** A patch as the window draws it: the repo by name, and everything else as its author wrote it. */
function patchView({ repo, base, branch, title, diff }: PatchContent, { applied, reviews }: Pick<PatchView, "applied" | "reviews"> = { applied: [], reviews: [] }, checkout = false): PatchView {
  return { repo: repo.name, base, branch, title, diff, applied, reviews, checkout };
}

/** The lesser of two modes. */
function least(a: PermissionMode, b: PermissionMode): PermissionMode {
  return atMost(a, b) ? a : b;
}

/** What the log and the clock say of an agent's request of another: the most its run may be let do, when its root was let run, and everyone it runs on the say of; or why it may not go. */
type Judged = { readonly ok: true; readonly mode: PermissionMode; readonly since: number; readonly people: readonly string[] } | { readonly ok: false; readonly reason: string };

export class Session {
  private readonly client: Client;
  private readonly dev: string;
  private readonly hooks: Hooks;
  private readonly runner: Runner;
  private readonly cloner: (url: string, destination: string) => Promise<void>;
  private readonly describe: (checkout: Checkout) => Promise<Head>;
  private readonly presence: number;
  private readonly progressEvery: number;
  private readonly heartbeat: number;
  private readonly limit: number;
  private readonly rootTime: number;
  private readonly me: string;
  private readonly chats: ChatLog;
  private readonly stopping = new AbortController();
  private readonly drafts = new Map<string, Draft[]>(); // Per chat, answers waiting for review, oldest first.
  private readonly runs = new Map<string, AgentRun>(); // By request and repo.
  private readonly waiting = new Map<string, Waiting>(); // Asks the user has not answered, by the id the view gives each.
  private readonly feeds = new Map<string, { readonly chat: string; readonly items: ActivityItem[] }>(); // Each run's activity, by its key, oldest run first. Only ever in memory.
  private asked = 0; // Asks made so far, for each one's id.
  private readonly read: Record<string, number>; // Per chat, the seq of the newest event the user has seen.
  private readonly choices: Record<string, z.infer<typeof choiceSchema>>; // How each asker's requests of each repo were last run, by `${asker} ${repo}`.
  private dismissed: readonly Room[]; // Branch rooms the user said not to suggest.
  private readonly paged = new Map<string, boolean>(); // Chats whose newest page has been loaded, and whether there may be events before what is loaded.
  private readonly linked = new Map<string, NoteView | null>(); // Notes linked to that are not loaded here, as the hub answered for each; null while it is being asked.
  private lastChat: string | null; // The chat that was open when the session last ran.
  private people: readonly Person[] = [];
  private channels: readonly ChannelInfo[] = [];
  private team: readonly TeamRepo[] = []; // Every repo anyone has checked out.
  private checkouts = new Map<string, Checkout>(); // The user's own, by repo name.
  private commits = new Map<string, string>(); // The commit each of them is on, by repo name, as of the last scan: what a run on a clean copy starts from.
  private readonly agentKeys = new Map<string, KeyObject>(); // The key of the agent in each of them, by repo name, once everyone has been told it this run.
  private readonly grants = new Map<string, Entry>(); // Every grant to everyone the log holds, by id: one of the user's may let a teammate's request of their agent run without them.
  private readonly revocations = new Map<string, Entry>(); // Every revocation, by id.
  private readonly acceptances = new Map<string, Entry>(); // The user's own job.accepted events of the last day, by id, wherever they were sent: what each grant let go, for its daily limit.
  private prefix = ""; // The key every repo this hub shares starts with; "" until the hub has said.
  private advertised: string | null = null; // What the hub was last told about the user's repos.
  private current = ""; // The open chat; "" until one exists.
  private newAfter: number | null = null;
  private focus: CurrentView["focus"] = null; // The message the user last opened a link to, while its chat stays open.
  private notesOpened = 0;
  private connected = false;
  private problem = "";
  private toldKey = false; // Whether the user has been told the hub lists another key for them.
  private loaded = false;
  private attentive = true; // Whether the user is looking at the window. Messages that arrive while they are not stay unread.
  private following: Promise<void> = Promise.resolve();
  private streaming: Promise<void> | null = null; // The hub's stream, followed once what was there before it has been loaded.
  private agentRunner: { readonly which: string; readonly runner: AgentRunner } | null = null; // The runner of the agent that answers, by the agent as configured.
  private tested: Tested; // How each agent did in the permission test, as saved.
  private readonly testing = new Set<Promise<Check>>(); // Permission tests going on, which stopping ends and waits for.

  constructor(client: Client, dev: string, hooks: Hooks, options: Options = {}) {
    this.client = client;
    this.dev = dev;
    this.hooks = hooks;
    this.runner = options.runner ?? runAgent;
    this.cloner = options.cloner ?? repos.clone;
    this.describe = options.describe ?? repos.describe;
    this.presence = options.presence ?? PRESENCE;
    this.progressEvery = options.progress ?? PROGRESS;
    this.heartbeat = options.heartbeat ?? HEARTBEAT;
    this.limit = options.limit ?? AGENT_TIMEOUT;
    this.rootTime = options.rootTime ?? ROOT_TIME;
    this.me = client.config.name;
    this.chats = new ChatLog(this.me);
    const saved = this.loadSaved();
    this.read = { ...saved.read };
    this.choices = { ...saved.choices };
    this.dismissed = saved.dismissed;
    this.lastChat = saved.chat;
    this.tested = permissionTests(client.home);
  }

  public start(): void {
    this.following = this.follow();
  }

  /**
   * Stop following the hub, stop every agent still working or being tested, end the sessions kept for follow-ups, and throw away every draft not sent, waiting briefly so each agent is gone and the chat has been told how each run ended.
   * A draft is lost with the desk, so its job ends as throwing it away ends it: declined.
   */
  public async stop(): Promise<void> {
    this.stopping.abort();
    const runs = [...this.runs.values()];
    for (const run of runs) {
      run.cancel.abort();
    }
    const unsent = [...this.drafts.values()].flat();
    this.drafts.clear();
    const declined = unsent.map((draft) => this.decline(draft.entry.event.id, draft.repo));
    const settled = new AbortController();
    // Sessions kept for follow-ups are ended now, and a run still going keeps none: its runner is closed.
    const retired = this.retire();
    await Promise.race([Promise.all([this.following, this.streaming, retired, ...runs.map((run) => run.done), ...declined, Promise.allSettled(this.testing)]), sleep(STOP_WAIT, settled.signal)]);
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
    if (isAboutMessages(command)) {
      await this.handleMessage(command);
    } else if (isAboutJobs(command)) {
      await this.handleJob(command);
    } else if (isAboutRooms(command)) {
      await this.handleRoom(command);
    } else {
      switch (command.do) {
        case "open":
          this.open(command.chat);
          break;
        case "older":
          await this.older();
          break;
        case "openNote":
          await this.openNote(command.id);
          break;
        case "joinChannel":
          await this.joinChannel(command.name);
          break;
        case "leaveChannel":
          await this.leaveChannel(command.chat);
          break;
        case "clone":
          await this.clone(command.repo);
          break;
        case "hold":
          await this.hold(command.repo, command.held);
          break;
        case "agents":
          this.client.saveAgents(command.agents, command.defaultAgent);
          if (this.agentRunner?.which !== JSON.stringify(defaultAgentOf(this.client.config))) {
            await this.retire();
          }
          this.hooks.changed();
          break;
      }
    }
  }

  /** What a channel is about: pinning a repo, or a branch of one, unpinning, and the branch rooms the chat list suggests. */
  private async handleRoom(command: Extract<ChatCommand, { readonly do: RoomDo }>): Promise<void> {
    switch (command.do) {
      case "pin":
        await this.pin(command.chat, command.repo, command.branch);
        break;
      case "unpin":
        await this.publish(command.chat, "channel.pin", { repo: null, branch: null });
        await this.refreshChannels();
        break;
      case "startRoom":
        await this.startRoom(command.repo, command.branch);
        break;
      case "dismissRoom":
        this.dismissed = [...this.dismissed, { repo: command.repo, branch: command.branch }];
        this.save();
        this.hooks.changed();
        break;
    }
  }

  private async handleMessage(command: Extract<ChatCommand, { readonly do: MessageDo }>): Promise<void> {
    switch (command.do) {
      case "send":
        await this.send(command.chat, command.text, []);
        break;
      case "reply": {
        const root = this.found(command.root);
        await this.send(chatOf(root.entry.event, this.me), command.text, [root.root ?? command.root]); // A reply to a reply goes to the root of its thread.
        break;
      }
      case "react": {
        const target = this.found(command.id);
        await this.publish(chatOf(target.entry.event, this.me), "reaction", { emoji: command.emoji, on: command.on }, [command.id]);
        break;
      }
      case "edit": {
        const text = fitText(command.text.trim());
        if (text === "") {
          throw new PlayerTwoError("a message cannot be edited down to nothing: delete it instead");
        }
        await this.publish(chatOf(this.mine(command.id).entry.event, this.me), "message.edit", { text }, [command.id]); // Its tags stay as they were sent: an edit starts nothing.
        break;
      }
      case "delete":
        await this.publish(chatOf(this.mine(command.id).entry.event, this.me), "message.delete", {}, [command.id]);
        break;
      case "applyPatch":
        await (command.newBranch === true ? this.applyToBranch(command.id) : this.applyPatch(command.id));
        break;
      case "review": {
        const patch = this.found(command.id);
        if (patch.patch === null) {
          throw new PlayerTwoError("only a patch is approved, or changes asked for");
        }
        await this.publish(chatOf(patch.entry.event, this.me), "review", { verdict: command.verdict, text: fitText(command.text.trim()) }, [command.id]);
        break;
      }
    }
  }

  private async handleJob(command: Extract<ChatCommand, { readonly do: JobDo }>): Promise<void> {
    switch (command.do) {
      case "sendDraft":
        await this.sendDraft(command.chat, command.id, command.repo, command.text);
        break;
      case "discardDraft":
        await this.discardDraft(command.chat, command.id, command.repo);
        break;
      case "run":
        this.runRequest(command.id, command.repo, command.post, command.mode, command.text, command.delegate ?? false);
        break;
      case "stop":
        this.runs.get(runOf(command.id, command.repo))?.cancel.abort();
        break;
      case "stopAll":
        for (const run of [...this.runs.values()].filter((each) => chatOf(each.entry.event, this.me) === command.chat)) {
          run.cancel.abort();
        }
        break;
      case "permit": {
        const waiting = this.waiting.get(command.ask);
        if (waiting === undefined) {
          throw new PlayerTwoError("your agent is no longer waiting for that answer");
        }
        this.waiting.delete(command.ask);
        waiting.answer(command.answer);
        this.hooks.changed();
        break;
      }
      case "decline":
        await this.decline(command.id, command.repo);
        break;
      case "withdraw":
        await this.withdraw(command.id, command.owner, command.repo);
        break;
      case "grant":
        await this.grant(command);
        break;
      case "revoke":
        await this.revoke(command.id);
        break;
    }
  }

  // ── what the window shows ─────────────────────────────────────────────────

  public view(): ChatView {
    const now = this.client.now();
    const rows = this.rows();
    const working = new Set([...this.runs.values()].map((run) => chatOf(run.entry.event, this.me)));
    const asked = new Map(rows.map((row) => [row.chat, this.chats.waitingForMe(row.chat, now).filter((request) => !this.isHeld(request.repo)).length]));
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
    const answering = defaultAgentOf(this.client.config);
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
      agents: this.client.config.agents,
      defaultAgent: this.client.config.defaultAgent,
      presets: PRESETS,
      cannot: { "read-only": this.cannotRun("read-only"), supervised: this.cannotRun("supervised"), "auto-edits": this.cannotRun("auto-edits"), full: this.cannotRun("full") },
      untested: answering.protocol === "acp" && this.tested[commandLineOf(answering)] === undefined,
      dev: this.dev.startsWith(home) ? `~${this.dev.slice(home.length)}` : this.dev,
      link,
      loaded: this.loaded,
      rows: rowViews,
      waiting: [...asked.values()].reduce((sum, count) => sum + count, 0),
      unread: rows.reduce((sum, row) => sum + row.unread, 0),
      team: this.team,
      myRepos: [...this.checkouts.keys()],
      checkouts: [...this.checkouts.values()].map(({ remote, branch }) => ({ repo: remote.name, branch, held: this.isHeld(remote.name), commit: this.commits.get(remote.name) ?? "" })),
      grants: this.myGrants(now),
      otherChannels: this.channels.filter((channel) => !channel.members.includes(this.me)).map((channel) => ({ name: channel.name, members: channel.members })),
      rooms: suggestions(this.team, this.me, this.channels, new Map([...this.checkouts.values()].map((checkout) => [checkout.remote.name, checkout.defaultBranch])), this.dismissed),
      busy: { working: this.runs.size, unsent: [...this.drafts.values()].reduce((sum, drafts) => sum + drafts.length, 0) },
      current: this.current === "" ? null : this.currentView(now)
    };
  }

  private currentView(now: number): CurrentView {
    const chat = this.current;
    const info = this.channels.find((channel) => channel.name === chat);
    const members = info?.members ?? [];
    const pinned = info?.repo ?? null;
    const branch = info?.branch ?? null;
    const copies = pinned === null ? [] : this.team.filter((repo) => repo.key === pinned.key); // Everyone's checkout of the pinned repo, as each advertises it.
    const elsewhere = copies.filter((copy) => copy.branch !== branch && members.includes(copy.user));
    return {
      chat,
      members: isChannel(chat) ? members : null,
      joined: members.includes(this.me),
      hasOlder: this.paged.get(chat) ?? false,
      pinned:
        pinned === null
          ? null
          : {
              name: pinned.name,
              have: members.filter((member) => copies.some((copy) => copy.user === member)).length,
              mine: this.checkouts.has(pinned.name),
              branch,
              on: branch === null ? [] : copies.filter((copy) => copy.branch === branch).map((copy) => copy.user),
              elsewhere: branch === null ? [] : elsewhere.map((copy) => ({ who: copy.user, branch: copy.branch }))
            },
      newAfter: this.newAfter,
      messages: this.messages(chat, now),
      lines: this.lines(chat),
      drafts: (this.drafts.get(chat) ?? []).map((draft) => ({
        id: draft.entry.event.id,
        repo: draft.repo,
        asker: draft.entry.event.author,
        text: draft.text,
        patch: draft.patch === null ? null : patchView(draft.patch)
      })),
      running: [...this.runs.values()].some((run) => chatOf(run.entry.event, this.me) === chat),
      activity: [...this.feeds.values()].flatMap((feed) => (feed.chat === chat ? feed.items : [])),
      asks: [...this.waiting].flatMap(([id, waiting]): AskView[] =>
        waiting.chat === chat ? [{ id, run: waiting.run, action: waiting.ask.action, title: oneLine(waiting.ask.title, 200), detail: waiting.ask.detail }] : []
      ),
      focus: this.focus
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
      const firstNew: boolean = !marked && this.newAfter !== null && seq > this.newAfter && ownerOf(event.author) !== this.me;
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
    const replies: ReplyView[] = [];
    let before: Message | null = null;
    for (const reply of message.replies) {
      replies.push(this.replyView(reply, before, now));
      before = reply;
    }
    return { ...this.replyView(message, previous, now), replyCount: replies.length, replies };
  }

  private replyView(message: Message, previous: Message | null, now: number): ReplyView {
    const { seq, event } = message.entry;
    const answered = this.chats.answered(message);
    const accepted = this.acceptedFor(message, now);
    return {
      id: event.id,
      seq,
      sender: ownerOf(event.author), // An agent's answer under its owner's name, as it was before agents signed their own: `agent` says it is the agent's, and `signer` whether the owner read it first.
      signer: event.author,
      agent: message.agent,
      branch: accepted === null ? message.branch : ranOn(accepted),
      commit: accepted?.commit ?? "",
      grant: this.answeredUnder(ownerOf(event.author), accepted),
      ts: event.ts,
      trusted: true,
      body: message.text,
      edited: message.edited,
      deleted: message.deleted,
      reactions: [...message.reactions].map(([emoji, people]) => ({ emoji, people: [...people] })),
      notes: this.notesOf(message.text),
      quote: answered === null ? "" : `${answered.entry.event.author}: ${oneLine(answered.text)}`,
      header: !continues(previous, message),
      requests: (message.deleted ? this.stillMine(message, now) : this.chats.requests(message, now)).flatMap((request) => this.requestView(request)),
      delegation:
        message.delegation === null ? null : { first: message.delegation.first, chain: message.delegation.chain, target: message.delegation.target, words: chainWords(message.delegation, this.me) },
      tree: this.treeView(message, now),
      patch: message.patch === null ? null : patchView(message.patch.content, message.patch, this.checkoutOf(message.patch.content.repo) !== undefined)
    };
  }

  /**
   * A deleted request asks nothing of anyone, so the fold gives it no jobs; but what the user's desk still has going on it stays theirs whatever its asker does:
   * a run, shown as running with its Stop, and a draft, to send or throw away.
   */
  private stillMine(message: Message, now: number): Request[] {
    const { event } = message.entry;
    const drafts = this.drafts.get(chatOf(event, this.me)) ?? [];
    const going = (repo: string): boolean => this.runs.has(runOf(event.id, repo)) || drafts.some((draft) => draft.entry.event.id === event.id && draft.repo === repo);
    return this.chats.requests(message, now, true).filter((request) => request.owner === this.me && going(request.repo));
  }

  /** An event whose signature failed: who it claims to be from and when, and never what it says. */
  private warningView({ seq, event }: Entry): MessageView {
    const nothing = {
      agent: null,
      branch: "",
      commit: "",
      grant: null,
      body: "",
      edited: false,
      deleted: false,
      reactions: [],
      notes: [],
      quote: "",
      requests: [],
      delegation: null,
      tree: [],
      patch: null,
      replyCount: 0,
      replies: []
    };
    return { id: event.id, seq, sender: event.author, signer: event.author, ts: event.ts, trusted: false, header: true, ...nothing };
  }

  /**
   * What each note a text links to is, as far as the desk knows: one loaded here as the fold has it, edits and all, and any other by who wrote it and where, as the hub answered for it.
   * One that is neither is asked of the hub, once, and left out until the answer comes and the window is told again.
   */
  private notesOf(text: string): NoteView[] {
    return [...new Set(notesIn(text).flatMap((piece) => piece.note ?? []))].flatMap((id): NoteView[] => {
      const loaded = this.chats.message(id);
      if (loaded !== null) {
        return [{ state: "seen", id, author: ownerOf(loaded.entry.event.author), words: loaded.deleted ? "message deleted" : oneLine(loaded.text) }];
      }
      if (!this.linked.has(id)) {
        this.linked.set(id, null);
        this.lookUp(id).catch(() => undefined); // It catches what it can fail with itself.
      }
      const known = this.linked.get(id) ?? null;
      return known === null ? [] : [known];
    });
  }

  /**
   * Ask the hub for a note linked to that is not loaded here. One it will not show this user, or whose signature fails, is a note they cannot see.
   * Any other is shown by who wrote it and where, never by its words: one event says nothing of a later edit or delete, so its words may be ones its author took back.
   * When the hub cannot be reached it is asked again the next time the link is drawn.
   */
  private async lookUp(id: string): Promise<void> {
    try {
      const found = await this.client.event(id);
      const trusted = found !== null && (await this.client.isTrusted(found));
      this.linked.set(id, found !== null && trusted ? { state: "elsewhere", id, author: ownerOf(found.event.author), chat: chatOf(found.event, this.me) } : { state: "hidden", id });
      this.hooks.changed();
    } catch {
      this.linked.delete(id);
    }
  }

  /** Someone joined, left, pinned or unpinned in the open chat, in order. */
  private lines(chat: string): LineView[] {
    return this.chats.items(chat).flatMap((item) => (item.kind === "line" ? [{ seq: item.entry.seq, ts: item.entry.event.ts, who: item.entry.event.author, did: item.did, repo: item.repo }] : []));
  }

  /** What an answer's run was let go ahead with: from the job it answers, when its request is loaded in the answer's own chat. */
  private acceptedFor(message: Message, now: number): Accepted | null {
    const request = this.chats.answered(message);
    const job = request === null ? undefined : this.chats.requests(request, now).find((each) => each.owner === ownerOf(message.entry.event.author) && each.repo === message.agent);
    return job?.accepted ?? null;
  }

  /** Where one tagged agent stands: for the user's own, what they can do; for a teammate's, how far it has got. Nothing once it is answered. */
  private requestView(request: Request): RequestView[] {
    const { owner, repo } = request;
    const mine = owner === this.me;
    const accepted =
      request.accepted === null
        ? null
        : {
            branch: request.accepted.branch,
            commit: request.accepted.commit,
            dirty: request.accepted.dirty,
            mode: request.accepted.mode,
            delegate: request.accepted.delegate,
            grant: this.ranUnder(owner, request.accepted)
          };
    return request.state === "answered" ? [] : [{ id: request.message.entry.event.id, owner, repo, mine, accepted, status: mine ? this.myStatus(request) : this.theirStatus(request) }];
  }

  /**
   * The grant of `owner`'s a run went ahead under, by the id its acceptance names, and when it ends: null when the owner let it run themselves, and `expires` null when no such grant of theirs
   * is held here, or it has been revoked, as it no longer lasts until then.
   */
  private ranUnder(owner: string, { by }: Accepted): NonNullable<RequestView["accepted"]>["grant"] {
    if (by === "owner") {
      return null;
    }
    const grant = this.grants.get(by.grant);
    const said = grant === undefined || revoked(grant, [...this.revocations.values()]) ? null : readContent(grant.event);
    return { id: by.grant, expires: grant?.trusted === true && grant.event.author === owner && said?.kind === "grant" ? said.content.expires : null };
  }

  /** The grant an answer's run went ahead under, with the mode it ran at, from its acceptance: null when its owner let it run themselves, or where it ran is unknown. */
  private answeredUnder(owner: string, accepted: Accepted | null): MessageView["grant"] {
    const grant = accepted === null ? null : this.ranUnder(owner, accepted);
    return accepted === null || grant === null ? null : { ...grant, mode: accepted.mode };
  }

  /** Every job under a message a person wrote, one line each, deepest last under its parent, when an agent it tags asked another; none otherwise. */
  private treeView(message: Message, now: number): ReplyView["tree"] {
    const lines: ReplyView["tree"][number][] = [];
    const walk = (nodes: readonly Node[], depth: number): void => {
      for (const { request, agent, children } of nodes) {
        const asked = this.chats.message(request.event.id);
        const job = asked === null ? undefined : this.chats.requests(asked, now, true).find((each) => `${each.owner}/${each.repo}` === agent);
        lines.push({ id: request.event.id, agent, depth, state: job?.state ?? "waiting", mode: job?.accepted?.mode ?? null });
        walk(children, depth + 1);
      }
    };
    // Only a message a person wrote that tags an agent is a root: the rest are not looked for in the chat.
    const tags = message.delegation === null && message.agent === null && this.chats.requests(message, now, true).length > 0;
    const roots = tags ? this.chats.tree(message.entry.event.id) : [];
    walk(roots.some((node) => node.children.length > 0) ? roots : [], 0);
    return lines;
  }

  /** The user's grants that stand, first made first, each with the runs it let go in the last 24 hours. */
  private myGrants(now: number): GrantView[] {
    return standing([...this.grants.values()], [...this.revocations.values()], [...this.acceptances.values()], now, this.unlogged()).flatMap(({ agent, ...grant }) =>
      agent.startsWith(`${this.me}/`) ? [{ ...grant, repo: agent.slice(this.me.length + 1) }] : []
    );
  }

  private myStatus(request: Request): RequestView["status"] {
    const { repo, state } = request;
    const { event } = request.message.entry;
    const run = this.runs.get(runOf(event.id, repo));
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
    if (this.isHeld(repo)) {
      return { kind: "held" };
    }
    const before = state === "working" ? "interrupted" : state === "waiting" || state === "answered" ? "" : state;
    const judged = request.message.delegation === null ? null : this.judge(request.message);
    if (judged?.ok === false) {
      return { kind: "mayNotGo", before, reason: judged.reason }; // Refused when run all the same, saying why.
    }
    const ceiling = judged === null ? "full" : judged.mode;
    const offer = this.offerFor(event.author, repo);
    return { kind: "ready", before, canDecline: event.author !== this.me && state !== "declined", offer: { ...offer, mode: least(offer.mode, ceiling) }, ceiling };
  }

  /**
   * What the log of its chat says of a request of the user's agent that another agent sent (see src/core/delegation.ts), and this desk's clock: the log holds a request to its root's
   * time by when it was sent, and the clock holds a run to it, so that nothing under a root starts or goes on once its time is up, whether or not the root's desk is there to stop its own.
   */
  private judge(message: Message): Judged {
    const log = this.chats.log(message.entry.event.id);
    const verdict = checkRequest(log, message.entry);
    const people = peopleInvolved(log, message.entry);
    if (!verdict.ok) {
      return verdict;
    }
    if (people === null) {
      return { ok: false, reason: "nobody here can say who asked first" };
    }
    return this.client.now() - verdict.since >= this.rootTime ? { ok: false, reason: `its root has been running for ${this.minutes()} minutes` } : { ...verdict, people };
  }

  /** The root's time in minutes, as the user is told it. */
  private minutes(): string {
    return String(Math.round(this.rootTime / 60));
  }

  /**
   * How a request from `asker` of `repo` is offered first: as the user last ran that asker's requests of it, while the agent that ran it is the one that answers, unchanged.
   * A `full` only while that agent can still be held to nothing less: a mode the user chose because nothing less was there is never one click once something less is.
   * Otherwise read-only, reviewed.
   */
  private offerFor(asker: string, repo: string): Offer {
    const choice = this.choices[`${asker} ${repo}`];
    const agent = defaultAgentOf(this.client.config);
    const same = choice?.agent?.id === agent.id && choice.agent.line === commandLineOf(agent);
    if (!same || (choice.mode === "full" && MODES.some((mode) => mode !== "full" && this.cannotRun(mode) === ""))) {
      return FIRST_CHOICE;
    }
    return { mode: choice.mode, post: choice.post };
  }

  private theirStatus(request: Request): RequestView["status"] {
    const { owner, repo, state } = request;
    if (state === "working") {
      return { kind: "working", branch: ranOn(request.accepted), summary: request.summary };
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
    // Where the stream starts: the hub's head, read before the first page, so that whatever is stored while the pages load comes with the stream.
    // Kept when a page fails and the rest are asked for again, since the chats already paged were read before anything stored since.
    let from: number | null = null;
    while (!stopped()) {
      let wait = this.presence;
      try {
        if (!greeted) {
          await this.greet();
          greeted = true;
        }
        await this.share();
        await this.refresh();
        from ??= (await this.client.head()).seq;
        await this.pageNew();
        if (this.streaming === null) {
          await this.loadGrants();
          this.loaded = true;
          this.openFirst();
          this.streaming = this.client.stream(from, (batch) => this.arrive(batch), this.stopping.signal);
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

  /** Look under ~/dev for the team's repos, tell the hub when the list or a branch has changed, and tell everyone the key of each one's agent; of those the user holds back, nothing. */
  private async share(): Promise<void> {
    const found = repos.scan(this.dev, this.prefix);
    const shared = found.filter((checkout) => !this.isHeld(checkout.remote.name));
    const adverts = shared.map((checkout) => ({ ...checkout.remote, branch: checkout.branch }));
    if (JSON.stringify(adverts) !== this.advertised) {
      await this.client.advertise(adverts);
      this.advertised = JSON.stringify(adverts);
      // The user's own part of the team is what the hub was just told, in the hub's order, rather than what it said on the last beat: a branch room shows them on their new branch at once.
      const mine = adverts.map((advert) => ({ ...advert, user: this.me }));
      this.team = [...this.team.filter((repo) => repo.user !== this.me), ...mine].sort((a, b) => byCodeUnit(`${a.name} ${a.user}`, `${b.name} ${b.user}`));
    }
    await this.register(shared);
    this.checkouts = new Map(found.map((checkout) => [checkout.remote.name, checkout]));
    const commits = new Map<string, string>();
    for (const { remote, path } of found) {
      commits.set(remote.name, await repos.commitOf(path)); // For the window to say which commit a teammate's run on a clean copy would start from.
    }
    this.commits = commits;
    this.hooks.changed();
  }

  /**
   * Tell everyone the key of the agent in each checkout whenever its file holds another than the one told this run of the session, unless the newest registration of mine for its repo already holds it.
   * So the first time a repo is shared its agent is registered, and replacing its key file rotates its key, on the next beat or before the next run, whichever comes first, as a run is pointed at the file.
   */
  private async register(found: readonly Checkout[]): Promise<void> {
    for (const { remote } of found) {
      const key = agentKey(this.client.home, remote.name);
      const pubkey = publicHex(key);
      const told = this.agentKeys.get(remote.name);
      if ((told === undefined || publicHex(told) !== pubkey) && (await this.client.registeredKey(`${this.me}/${remote.name}`)) !== pubkey) {
        await this.client.publish("*", "agent.register", { repo: remote.name, pubkey });
      }
      this.agentKeys.set(remote.name, key);
    }
  }

  /** Ask who is here, which channels there are and who has which repo; and tell the user, once, when the hub lists another key for them than the one this machine holds, which is never believed. */
  private async refresh(): Promise<void> {
    const [people, channels, team] = await Promise.all([this.client.users(), this.client.channels(), this.client.repos()]);
    const listed = people.find((person) => person.name === this.me)?.pubkey ?? this.client.ownKey;
    if (listed !== this.client.ownKey && !this.toldKey) {
      this.toldKey = true;
      this.hooks.notice({
        title: "the hub lists another key for you than this machine's",
        body: `It says ${this.me}'s key is ${listed}, and ${joinPath(this.client.home, "key")} holds ${this.client.ownKey}. Only what your own key signed is taken as yours, but the hub may be trying to pass something off in your name: tell whoever runs it.`,
        severity: "error"
      });
    }
    this.people = people;
    this.channels = channels;
    this.team = team;
    this.connected = true;
    this.problem = "";
    this.openFirst();
    this.hooks.changed();
  }

  /** Load the newest page of each chat in the list that has not had one: every chat at start-up, and later a channel joined elsewhere or a person new to the hub. */
  private async pageNew(): Promise<void> {
    await Promise.all(
      this.rows()
        .filter((row) => !this.paged.has(row.chat))
        .map((row) => this.page(row.chat))
    );
  }

  /** Load a chat's newest page, or with `before` the page before that seq, and note whether there may be more before it. */
  private async page(chat: string, before?: number): Promise<void> {
    const found = await this.client.events(before === undefined ? { chat, limit: PAGE } : { chat, before, limit: PAGE });
    this.take(await this.trust(found), false);
    this.paged.set(chat, found.length === PAGE);
  }

  /**
   * Load the page of a chat centred on `seq`, then what lies between it and what was loaded already, so that the chat shows no hole.
   * ponytail: the hole is loaded whole, a page at a time; a link far back in a long chat costs a request for each PAGE events after it. Keep a chat as separate stretches if that grows slow.
   */
  private async pageAround(chat: string, seq: number): Promise<void> {
    if (!this.paged.has(chat)) {
      await this.page(chat);
    }
    const loaded = this.chats.bounds(chat);
    const found = await this.client.around({ chat, around: seq, limit: PAGE });
    this.take(await this.trust(found), false);
    if ((found[0]?.seq ?? Infinity) < (loaded?.oldest ?? Infinity)) {
      this.paged.set(chat, found.filter((each) => each.seq < seq).length === Math.floor(PAGE / 2)); // The hub gives up to half the page from before `seq`: fewer means there is nothing before.
    }
    const reached = found.at(-1)?.seq ?? seq;
    for (let before = loaded?.oldest; before !== undefined && before > reached;) {
      const page = await this.client.events({ chat, before, limit: PAGE });
      this.take(await this.trust(page), false);
      before = page.length === PAGE ? page.at(-1)?.seq : undefined;
    }
  }

  /** The page before the oldest event loaded in the open chat. */
  private async older(): Promise<void> {
    const oldest = this.chats.bounds(this.current)?.oldest;
    if (this.current !== "" && oldest !== undefined && this.paged.get(this.current) === true) {
      await this.page(this.current, oldest);
    }
  }

  /** What the stream has just delivered. Should this fail, the stream delivers it again. Someone joining, leaving or pinning changes what the window says about the channel, so its members and pin are asked for again. */
  private async arrive(batch: readonly Delivered[]): Promise<void> {
    const entries = await this.trust(batch);
    const fresh = this.take(entries, true);
    this.underGrants(entries);
    await this.delegated(fresh);
    if (batch.some((delivered) => delivered.event.kind.startsWith("channel."))) {
      await this.refreshChannels().catch(() => undefined); // Best effort: the next presence check asks again.
    }
  }

  private async trust(found: readonly Delivered[]): Promise<Entry[]> {
    const entries: Entry[] = [];
    for (const delivered of found) {
      entries.push({ ...delivered, trusted: await this.client.isTrusted(delivered) });
    }
    return entries;
  }

  /** Fold what the hub delivered, and return what was new. */
  private take(entries: readonly Entry[], announce: boolean): Entry[] {
    const fresh = this.chats.add(entries);
    this.keep(entries);
    for (const key of this.runs.keys()) {
      this.holdFor(key);
      this.stopUnwanted(key);
    }
    this.openFirst();
    if (announce) {
      this.announce(fresh.filter((entry) => ["message", "job.result", "job.request"].includes(entry.event.kind) && ownerOf(entry.event.author) !== this.me && mayCome(entry.event)));
    }
    this.markRead();
    this.hooks.changed();
    return fresh;
  }

  /** Once what was there has been loaded, open a chat when none is open: where something is waiting, failing that where the user left off, failing that the first. */
  private openFirst(): void {
    if (this.loaded && this.current === "") {
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
      const said = readContent(event);
      const asked: (readonly [string, string])[] =
        entry.trusted && said.kind === "job.request" && ownerOf(said.content.target) === this.me ? [[this.me, said.content.target.slice(this.me.length + 1)]] : [];
      const tagged = entry.trusted && event.kind === "message" ? mentions(text).filter(([owner]) => owner === this.me) : asked;
      const where = isChannel(event.to) ? ` in ${event.to}` : "";
      const who = asked.length > 0 ? agentWords(event.author, this.me) : event.author;
      const title = tagged[0] === undefined ? `${fromWords(event, this.me)}${where}` : `${who} ${asked.length > 0 ? "asked" : "tagged"} your ${tagged[0][1]} agent${where}`;
      this.hooks.arrived({
        chat: chatOf(event, this.me),
        title,
        body: entry.trusted ? oneLine(text, 120) : "a message failed its signature check",
        forMe: tagged.length > 0,
        rings: rings(entry, this.me) || asked.length > 0
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
      this.save();
    }
  }

  private save(): void {
    writeFileSync(this.savedPath(), JSON.stringify(savedSchema.parse({ read: this.read, chat: this.lastChat, choices: this.choices, dismissed: this.dismissed }), null, 1));
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
      // A file from another version only costs read marks, the last open chat and how requests were last run.
    }
    return { read: {}, chat: null, choices: {}, dismissed: [] };
  }

  // ── what the user does ────────────────────────────────────────────────────

  private open(chat: string): void {
    if (chat === this.current || !this.rows().some((row) => row.chat === chat)) {
      return;
    }
    const mark = this.read[chat];
    this.newAfter = mark !== undefined && this.chats.unread(chat, mark) > 0 ? mark : null; // A chat never opened has no "left off".
    this.current = chat;
    this.focus = null;
    this.markRead();
    this.hooks.changed();
  }

  /**
   * Send what the user typed, as a message or with `refs` as a reply in a thread. They typed it here, so its tags of their own agents run at once without asking, at the mode they chose for their own requests:
   * its id is known as soon as it is signed, so it is folded in its place and run from there.
   * Nothing else the user sends starts an agent, and nothing that arrives from the hub does unless a grant of theirs lets a teammate's request go (see `underGrants`):
   * a message from anyone else, from the command or anything else that is not this window, or from this window before the desk last started, waits for the owner's click.
   */
  private async send(chat: string, text: string, refs: readonly string[]): Promise<void> {
    const body = fitText(text.trim());
    if (body === "") {
      return;
    }
    const sent = await this.publish(chat, "message", { text: body, via: "window" }, refs);
    const message = this.chats.message(sent.event.id);
    for (const request of message === null ? [] : this.chats.requests(message, this.client.now())) {
      if (message !== null && request.owner === this.me && request.state === "waiting" && this.answers(request.repo)) {
        const mode = this.ownMode();
        const why = this.cannotRun(mode);
        if (why === "") {
          this.startRun(message, request.repo, true, mode, null, true); // The user's own request may ask other agents, each of whose owners still decides.
        } else {
          const config = joinPath(this.client.home, "config.json");
          const body = `${why}. To let your own requests run it, make an agent spoken to over ACP, such as Cursor or Copilot, the one that answers on the Setup page, or set "ownMode" to "full" in ${config}`;
          this.hooks.notice({ title: `your ${request.repo} agent did not start`, body, severity: "error" }); // The message is sent all the same.
        }
      }
    }
  }

  /** Publish an event and fold it at once under the id it was signed with, so the window shows it without waiting for the stream, which brings it again to be kept once. */
  private async publish<K extends Content["kind"]>(to: string, kind: K, content: ContentOf<K>, refs: readonly string[] = []): Promise<Delivered> {
    const sent = await this.client.publish(to, kind, content, refs);
    this.take([{ ...sent, trusted: true }], false);
    return sent;
  }

  /** A message or an answer the window named. */
  private found(id: string): Message {
    const message = this.chats.message(id);
    if (message === null) {
      throw new PlayerTwoError("that message is not loaded here");
    }
    return message;
  }

  /** One of the user's own messages, to edit or delete. Anyone else's, an agent's answer, and one already deleted are refused: nobody would count the change. */
  private mine(id: string): Message {
    const message = this.found(id);
    if (message.entry.event.author !== this.me || message.agent !== null || message.deleted) {
      throw new PlayerTwoError("only your own messages can be edited or deleted");
    }
    return message;
  }

  /**
   * Open the chat a message or an answer is in, with the page around it loaded, and set the view's focus on it for the window to scroll to and highlight.
   * One not loaded here is asked of the hub. One the hub will not show the user, one whose signature fails, one in a chat not in their list, and an event that is not a message or an answer, open nothing.
   */
  private async openNote(id: string): Promise<void> {
    if (this.chats.message(id) === null) {
      const found = await this.client.event(id);
      const chat = found === null ? "" : chatOf(found.event, this.me);
      if (found !== null && this.rows().some((row) => row.chat === chat) && (await this.client.isTrusted(found))) {
        await this.pageAround(chat, found.seq);
      }
    }
    const message = this.chats.message(id);
    if (message === null) {
      throw new PlayerTwoError("that link is to a note you cannot see");
    }
    this.open(chatOf(message.entry.event, this.me));
    this.notesOpened += 1;
    this.focus = { id, nth: this.notesOpened };
    this.hooks.changed();
  }

  /** What the hub finds for `q` in every chat the user can see, best match first, for the window's search. One whose signature fails is left out, as its text never reaches the window, and so is one the fold counts for nothing (`mayCome`). */
  public async search(q: string): Promise<Hit[]> {
    let found: Found[];
    try {
      found = await this.client.search({ q });
    } catch (error) {
      throw error instanceof Refused && error.status === 422 ? new PlayerTwoError("a search holds 1 to 8 words, in at most 200 characters") : error;
    }
    const hits: Hit[] = [];
    for (const { seq, event, snippet } of found) {
      const said = readContent(event);
      if (mayCome(event, said) && (await this.client.isTrusted({ seq, event }))) {
        hits.push({ id: event.id, chat: chatOf(event, this.me), sender: ownerOf(event.author), signer: event.author, agent: said.kind === "job.result" ? said.content.repo : null, snippet });
      }
    }
    return hits;
  }

  /**
   * Take back a request the user made of someone's agent, while it is still waiting; or while it works on it let ask other agents, which ends everything under it:
   * its owner's desk stops it, and each desk under it stops what it was asked.
   */
  private async withdraw(request: string, owner: string, repo: string): Promise<void> {
    const message = this.found(request);
    const job = this.chats.requests(message, this.client.now()).find((each) => each.owner === owner && each.repo === repo);
    if (message.entry.event.author !== this.me || !(job?.state === "waiting" || (job?.state === "working" && job.accepted?.delegate === true))) {
      throw new PlayerTwoError("only a request of yours that is still waiting, or that an agent let ask others is working on, can be taken back");
    }
    await this.publish(chatOf(message.entry.event, this.me), "job.withdrawn", { agent: `${owner}/${repo}` }, [request]);
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

  /** Send a draft as the user edited it, and before it the patch that goes with it, unchanged: both signed by the user, who reviewed them. */
  private async sendDraft(chat: string, request: string, repo: string, text: string): Promise<void> {
    const draft = this.takeDraft(chat, request, repo);
    const edited = fitText(text.trim());
    let patch = draft.patch;
    try {
      if (patch !== null) {
        await this.client.publish(chat, "patch", patch, [request]);
        patch = null; // Sent: should the answer not be, what is put back is the answer alone.
      }
      await this.client.publish(chat, "job.result", { repo, branch: draft.branch, text: edited, reviewed: true }, [request]);
    } catch (error) {
      this.drafts.set(chat, [{ ...draft, text: edited, patch }, ...(this.drafts.get(chat) ?? [])]); // Put it back as edited, so nothing the user or their agent wrote is lost.
      this.hooks.changed();
      throw error;
    }
  }

  private async discardDraft(chat: string, request: string, repo: string): Promise<void> {
    this.takeDraft(chat, request, repo);
    await this.decline(request, repo);
  }

  /**
   * Run the user's agent on a request at `mode`, with its text as it stands now; which must be what the user was shown, `seen`, when they said to run it, or the agent would be given something they never saw.
   * The mode is the user's choice each time: a teammate's request is offered read-only first, and then as the user last ran that asker's requests of that repo (see `offerFor`).
   */
  private runRequest(request: string, repo: string, post: boolean, mode: PermissionMode, seen: string, delegate: boolean): void {
    const message = this.chats.message(request);
    if (message !== null && this.chats.requests(message, this.client.now()).some((each) => each.owner === this.me && each.repo === repo && each.state !== "withdrawn")) {
      if (message.text !== seen) {
        throw new PlayerTwoError(`${message.entry.event.author} edited the request after you saw it: read it again before you run it`);
      }
      this.startRun(message, repo, post, mode, null, delegate);
      const agent = defaultAgentOf(this.client.config);
      this.choices[`${message.entry.event.author} ${repo}`] = { mode, post, agent: { id: agent.id, line: commandLineOf(agent) } };
      this.save();
    }
  }

  /** Say no to a request for one of the user's agents. Best effort: the chat misses one line. */
  private async decline(request: string, repo: string): Promise<void> {
    const message = this.chats.message(request);
    if (message !== null) {
      await this.client.publish(chatOf(message.entry.event, this.me), "job.declined", { repo, reason: "" }, [request]).catch(() => undefined);
    }
  }

  /**
   * Join a channel, which makes it if nobody is in it, and load its newest page: its earlier events are behind the stream's place in the log.
   * Before the stream is followed, that place is not fixed yet, and what is stored between a page and it would be in neither; the first pages loaded once it is take the channel in with every other chat.
   */
  private async joinChannel(name: string): Promise<void> {
    const bare = nameSchema.safeParse(name.trim().replace(/^#/, ""));
    if (!bare.success) {
      throw new PlayerTwoError("a channel's name is lowercase letters, digits, - and _, at most 32 characters");
    }
    const channel = `#${bare.data}`;
    await this.publish(channel, "channel.join", {});
    this.linked.clear(); // A note in the channel that the hub would not show before, it shows now.
    await this.refreshChannels();
    if (this.streaming !== null) {
      await this.page(channel);
    }
    this.open(channel);
  }

  /**
   * Leave a channel, and forget what was said in it here. Not while one of the user's agents is at work there or its draft waits there:
   * the channel would be gone from the window, Stop and the draft with it, and the hub takes nothing more from the user there, so neither could end in it.
   */
  private async leaveChannel(chat: string): Promise<void> {
    if (!isChannel(chat)) {
      return;
    }
    const run = [...this.runs.values()].find((each) => chatOf(each.entry.event, this.me) === chat);
    if (run !== undefined) {
      throw new PlayerTwoError(`your ${run.repo} agent is still working in ${chat}: stop it before you leave`);
    }
    const draft = this.drafts.get(chat)?.[0];
    if (draft !== undefined) {
      throw new PlayerTwoError(`your ${draft.repo} agent's draft is waiting in ${chat}: send or discard it before you leave`);
    }
    await this.client.publish(chat, "channel.leave", {}); // Not folded: what was said in the channel is forgotten here.
    await this.refreshChannels();
    this.chats.forget(chat);
    this.paged.delete(chat);
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

  /** Say which repo a channel is about, one the user has a checkout of, and with a branch, which branch of it: a branch room. */
  private async pin(chat: string, repo: string, branch: string | null): Promise<void> {
    const checkout = this.checkouts.get(repo);
    if (checkout === undefined) {
      throw new PlayerTwoError(`you have no checkout of ${repo} to pin`);
    }
    await this.publish(chat, "channel.pin", { repo: refOf(checkout.remote), branch });
    await this.refreshChannels();
  }

  /** Start a room about a branch of one of the user's repos: a channel named from both, which they join and pin to it. The channels are asked for first, for a name nobody has taken since. */
  private async startRoom(repo: string, branch: string): Promise<void> {
    if (!this.checkouts.has(repo)) {
      throw new PlayerTwoError(`you have no checkout of ${repo} to start a room about`);
    }
    await this.refreshChannels();
    const taken = this.channels.map((channel) => channel.name);
    const name = roomName(repo, branch, taken);
    await this.joinChannel(name);
    await this.pin(name, repo, branch);
  }

  /** Ask again who is in each channel and what it is pinned to, after the user or someone else changed either. */
  private async refreshChannels(): Promise<void> {
    this.channels = await this.client.channels();
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

  /** The user's checkout of a repo, found by its key, which says which repo it is wherever it was cloned from, and its name; undefined when they have none of that name and key. */
  private checkoutOf(repo: RepoRef): Checkout | undefined {
    return [...this.checkouts.values()].find((checkout) => checkout.remote.key === repo.key && checkout.remote.name === repo.name);
  }

  /**
   * A patch in the chat, by its id, and the user's checkout of its repo to apply it to, once its paths have been read: refused, before git sees it, when one is outside the repo or
   * inside .git, or goes through a symbolic link in the checkout.
   */
  private toApply(id: string): { readonly message: Message; readonly patch: PatchContent; readonly checkout: Checkout } {
    const message = this.found(id);
    const patch = message.patch?.content;
    if (patch === undefined) {
      throw new PlayerTwoError("that is not a patch");
    }
    const checkout = this.checkoutOf(patch.repo);
    if (checkout === undefined) {
      throw new PlayerTwoError(`you have no checkout of ${patch.repo.name} under ${this.dev} to apply it to`);
    }
    const unsafe = unsafePaths(patch.diff);
    if (unsafe.length > 0) {
      throw new PlayerTwoError(`not applied: it names ${unsafe.map(plain).join(", ")}, which is outside the repo or inside .git, where a patch must never write`);
    }
    patches.refuseLinks(checkout.path, patch.diff);
    return { message, patch, checkout };
  }

  /**
   * Put a patch to the user before it is applied, in a dialog of the system's own: who it is from, what it goes `onto`, its title, the repo and `where` in it, then `warnings`, with one of
   * its own when it makes symbolic links and one when it changes files their agents read as instructions, and last its files with what each adds and removes, so that no number of files,
   * nor a long name, puts a warning out of sight. Everything from the diff is drawn plain, and each name cut to its end. Resolves with whether they said yes, on the button that reads `confirm`.
   */
  private async mayApply(
    { message, patch, checkout }: ReturnType<Session["toApply"]>,
    { onto, where, warnings, confirm }: { readonly onto: string; readonly where: string; readonly warnings: readonly string[]; readonly confirm: string }
  ): Promise<boolean> {
    const { author } = message.entry.event;
    const from = isAgent(author) ? `${agentWords(author, this.me)}, which nobody reviewed,` : author === this.me ? "you" : author;
    const files = parseDiff(patch.diff).map((file) => {
      const mode = modeOf(file);
      return `  ${file.from === null ? named(file.path) : `${named(file.from)} → ${named(file.path)}`}  +${String(file.added)} −${String(file.removed)}${mode === "" ? "" : `  ${mode}`}`;
    });
    const instructions = touchesInstructions(patch.diff);
    const executables = makesExecutable(patch.diff);
    const warned = [
      ...warnings,
      // A header line, as git writes one: no line of a hunk starts so.
      ...(/^(?:new file mode|new mode) 120000$/m.test(patch.diff)
        ? ["⚠ It makes symbolic links, which point wherever their author chose: see where each points before anything reads through one."]
        : []),
      ...(executables.length > 0 ? [`⚠ It makes files executable, which run whatever they hold when anything starts them: ${listed(executables)}.`] : []),
      ...(instructions.length > 0 ? [`⚠ It changes files your agents read as instructions: ${listed(instructions)}. Read them before an agent works here again.`] : [])
    ];
    const lines = [plain(patch.title), "", `Repo: ${checkout.remote.name}, in ${checkout.path}`, where, "", ...(warned.length > 0 ? [...warned, ""] : []), "Files:", ...files.slice(0, 20)];
    const question = { message: `Apply this patch from ${from} to ${onto}?`, detail: [...lines, ...(files.length > 20 ? [`  and ${String(files.length - 20)} more`] : [])].join("\n"), confirm };
    return (await this.hooks.confirm?.(question)) === true;
  }

  /**
   * Apply a patch in the chat to the user's checkout of its repo, on the branch it is on, as its card's Apply asks: refused before git sees it when it names a path outside the repo or
   * inside .git (see `toApply`), then refused with git's words when it does not apply; then put to the user in a dialog of the system's own that names the repo, the branch the checkout
   * is on and the files, and warns of work not committed and of files their agents read as instructions. Only on yes is it applied, and the chat told on which branch.
   */
  private async applyPatch(id: string): Promise<void> {
    const target = this.toApply(id);
    const { message, patch, checkout } = target;
    const { conflicts } = await patches.check(checkout.path, patch.diff);
    const head = await this.describe(checkout);
    const warnings = [
      ...(head.dirty ? ["⚠ Your checkout has changes you have not committed. The patch goes in beside them, and is added to the index."] : []),
      ...(conflicts ? ["⚠ It does not apply cleanly: git will leave conflict markers in what it cannot merge, for you to resolve."] : [])
    ];
    if (!(await this.mayApply(target, { onto: `your ${checkout.remote.name} checkout`, where: `Branch: ${head.branch}`, warnings, confirm: "Apply" }))) {
      return;
    }
    const applied = await patches.apply(checkout.path, patch.diff);
    if (applied.conflicts) {
      this.hooks.notice({ title: `the patch was applied to ${checkout.remote.name} with conflicts`, body: `Resolve them in ${checkout.path}.`, severity: "error" });
    }
    await this.publish(chatOf(message.entry.event, this.me), "patch.applied", { branch: head.branch }, [id]);
  }

  /**
   * Apply a patch to a new branch of the user's checkout, `player-two/` and the first 8 of its id, made from the commit the patch was made on, as one commit: refused as Apply refuses
   * one, and when the checkout's repository lacks that commit or has the branch already; then asked, and only on yes made. The branch the checkout is on, its working tree and its index
   * are left as they are.
   */
  private async applyToBranch(id: string): Promise<void> {
    const target = this.toApply(id);
    const { message, patch, checkout } = target;
    const branch = `player-two/${id.slice(0, 8)}`;
    await patches.checkBranch(checkout.path, patch.base, branch, patch.diff);
    const head = await this.describe(checkout);
    const where = `New branch: ${branch}, from ${patch.base.slice(0, 7)}, the commit it was made on. ${head.branch}, which your checkout is on, and your working tree are left as they are.`;
    if (!(await this.mayApply(target, { onto: `a new branch of your ${checkout.remote.name} checkout`, where, warnings: [], confirm: "Create the branch" }))) {
      return;
    }
    await patches.commitBranch(checkout.path, patch.base, branch, patch.diff, patch.title);
    await this.publish(chatOf(message.entry.event, this.me), "patch.applied", { branch }, [id]);
  }

  // ── standing grants ───────────────────────────────────────────────────────

  /**
   * Read what grants are decided by, before the stream is followed: every event to everyone, newest first back to the first, for the grants and their revocations;
   * and the user's own acceptances of the last day, from wherever they were sent, so that what a grant let go before the desk started counts against its daily limit.
   */
  private async loadGrants(): Promise<void> {
    for (let before: number | undefined; ;) {
      const page = await this.client.events(before === undefined ? { chat: "*", limit: EVERYONE } : { chat: "*", before, limit: EVERYONE });
      this.keep(await this.trust(page));
      before = page.at(-1)?.seq;
      if (page.length < EVERYONE) {
        break;
      }
    }
    const day = await this.client.since(this.client.now() - DAY);
    this.keep(await this.trust(day.filter(({ event }) => event.kind === "job.accepted" && event.author === this.me)));
  }

  /**
   * Keep, of what the hub delivered, what grants are decided by: every grant sent to everyone, every revocation, and the user's own acceptances of the last day.
   * A run under a grant that has been revoked is stopped: the revocation takes back the say-so it ran on, and the user can still run the request themselves.
   */
  private keep(entries: readonly Entry[]): void {
    const now = this.client.now();
    for (const entry of entries) {
      const { id, kind, author, to } = entry.event;
      if (kind === "grant" && to === "*") {
        this.grants.set(id, entry);
      } else if (kind === "grant.revoke") {
        this.revocations.set(id, entry);
      } else if (kind === "job.accepted" && author === this.me) {
        this.acceptances.set(id, entry);
      }
    }
    for (const [id, { event }] of this.acceptances) {
      if (now - event.ts >= DAY) {
        this.acceptances.delete(id);
      }
    }
    const revocations = [...this.revocations.values()];
    for (const run of this.runs.values()) {
      const grant = this.grants.get(run.grant ?? "");
      if (grant !== undefined && revoked(grant, revocations)) {
        run.cancel.abort();
      }
    }
  }

  /**
   * Let each request of the user's agents that arrives from a teammate run when a grant of the user's lets it: at the grant's mode and with its delivery, never more, and job.accepted names the grant.
   * One of the user's own never runs under a grant: from this window it runs at once, and from anywhere else it waits for their click, so an agent that sends one in their name cannot start itself.
   * Only a request that arrives while the desk follows the hub is let go: one that waited while it was not running waits for a click, and so does one signed longer ago than the hub
   * and this clock can differ twice over, as the stream hands over what was stored while it was down.
   * When the agent that answers cannot be held to the grant's mode, the request waits for a click as any other, and the user is told why.
   */
  private underGrants(arrived: readonly Entry[]): void {
    const now = this.client.now();
    for (const { trusted, event } of arrived) {
      const fresh = now - event.ts <= 2 * MAX_SKEW;
      const message = trusted && fresh && event.kind === "message" && event.author !== this.me ? this.chats.message(event.id) : null;
      if (message === null) {
        continue;
      }
      for (const { owner, repo, state } of this.chats.requests(message, now)) {
        const grant = owner === this.me && state === "waiting" && this.answers(repo) ? this.grantFor(repo, event.author, now) : null;
        if (grant === null) {
          continue;
        }
        try {
          this.startRun(message, repo, grant.delivery === "post", grant.mode, grant.id, false); // Nobody watches a run under a grant ask other agents in the owner's name.
        } catch (error) {
          this.hooks.notice({ title: `your ${repo} agent did not run ${event.author}'s request under your grant`, body: problemOf(error), severity: "error" });
        }
      }
    }
  }

  /**
   * Judge each request of the user's agents that another agent sent, as it arrives, from the log of the chat it was sent to, its root's loaded first when it is not: one that may not go
   * is declined, saying why; one a grant of the user's covers, naming everyone it runs on the say of but them, runs under it, at no more than the agents it came through were let do,
   * and never asking others in turn, when it arrives fresh as a teammate's request must; any other waits for the user, as a tag does. A chain everyone in which is the user consults no grant,
   * as their own request never does.
   */
  private async delegated(arrived: readonly Entry[]): Promise<void> {
    for (const entry of arrived) {
      const said = readContent(entry.event);
      if (entry.trusted && said.kind === "job.request" && ownerOf(said.content.target) === this.me) {
        await this.loadRoot(entry);
        this.decide(entry, said.content.target.slice(this.me.length + 1));
      }
    }
  }

  /** Load the page of the chat a request is in around its root, when the root is not loaded here, so that its chain can be judged. Best effort: one not loaded is judged without it. */
  private async loadRoot({ event }: Entry): Promise<void> {
    const root = event.refs[0] ?? "";
    if (this.chats.message(root) !== null) {
      return;
    }
    const found = await this.client.event(root).catch(() => null);
    if (found !== null && chatOf(found.event, this.me) === chatOf(event, this.me)) {
      await this.pageAround(chatOf(event, this.me), found.seq).catch(() => undefined);
    }
  }

  /** Decline the request of the user's agent in `repo` that another agent sent, saying why, when the log does not let it go; or run it under a grant of the user's that covers it. */
  private decide({ event }: Entry, repo: string): void {
    const now = this.client.now();
    const message = this.chats.message(event.id);
    if (message === null || this.chats.requests(message, now)[0]?.state !== "waiting") {
      return;
    }
    const judged = this.judge(message);
    if (!judged.ok) {
      this.publish(chatOf(event, this.me), "job.declined", { repo, reason: judged.reason }, [event.id]).catch(() => undefined); // Best effort, as any decline.
      return;
    }
    const fresh = now - event.ts <= 2 * MAX_SKEW; // As a teammate's tag must be to run under a grant: see `underGrants`.
    const mine = judged.people.every((person) => person === this.me);
    const grant =
      fresh && !mine && this.answers(repo)
        ? liveGrant([...this.grants.values()], [...this.revocations.values()], [...this.acceptances.values()], { agent: `${this.me}/${repo}`, people: judged.people, now, unlogged: this.unlogged() })
        : null;
    if (grant === null) {
      return;
    }
    try {
      this.startRun(message, repo, grant.delivery === "post", least(grant.mode, judged.mode), grant.id, false);
    } catch (error) {
      this.hooks.notice({ title: `your ${repo} agent did not run ${agentWords(event.author, this.me)}'s request under your grant`, body: problemOf(error), severity: "error" });
    }
  }

  /** The grant of the user's that lets `asker`'s request of their agent in `repo` run at `now`; null when none does. */
  private grantFor(repo: string, asker: string, now: number): Standing | null {
    return liveGrant([...this.grants.values()], [...this.revocations.values()], [...this.acceptances.values()], { agent: `${this.me}/${repo}`, people: [asker], now, unlogged: this.unlogged() });
  }

  /** The grant of each run going under one that the log does not hold the acceptance of yet. */
  private unlogged(): string[] {
    return [...this.runs.values()].flatMap((run) => (run.accepting && run.grant !== null ? [run.grant] : []));
  }

  /**
   * Let teammates ask the user's agent in `repo` with nobody at the desk, by a grant to everyone: from now for `lasts` seconds, at a mode, with its answers posted or kept for review, so many times a day.
   * Whether the agent that answers can keep the mode is asked when a request comes: it may be another agent by then.
   */
  private async grant({ repo, askers, mode, delivery, lasts, runsPerDay }: Extract<ChatCommand, { readonly do: "grant" }>): Promise<void> {
    if (!this.checkouts.has(repo)) {
      throw new PlayerTwoError(`there is no checkout of ${repo} under ${this.dev}, so no agent of yours answers for it`);
    }
    await this.publish("*", "grant", { agent: `${this.me}/${repo}`, askers, mode, delivery, expires: Math.floor(this.client.now()) + lasts, runsPerDay });
  }

  /** Whether the user holds back their agent in `repo`: the hub is not told of it, and it answers nobody, under a grant or not. */
  private isHeld(repo: string): boolean {
    return this.client.config.held?.includes(repo) === true;
  }

  /** Whether the user's agent in `repo` answers: they have a checkout of it and do not hold it back. */
  private answers(repo: string): boolean {
    return this.checkouts.has(repo) && !this.isHeld(repo);
  }

  /**
   * Hold back the user's agent in `repo`, or let it answer again, and tell the hub at once what they share. A run already going is left to finish, or to be stopped by hand:
   * holding back stops the agent being asked, not what it was let do.
   */
  private async hold(repo: string, held: boolean): Promise<void> {
    const others = (this.client.config.held ?? []).filter((each) => each !== repo);
    this.client.saveHeld(held ? [...others, repo] : others);
    await this.share();
  }

  /** Take back a grant of the user's: it lets nothing run from now on, and a run going under it is stopped (see `keep`). */
  private async revoke(id: string): Promise<void> {
    if (this.grants.get(id)?.event.author !== this.me) {
      throw new PlayerTwoError("that is not a grant of yours");
    }
    await this.publish("*", "grant.revoke", {}, [id]);
  }

  // ── running an agent ──────────────────────────────────────────────────────

  /**
   * Why the agent that answers cannot be held to `mode`, "" when it can. Where a mode is chosen, only one it can keep is offered, and a run at any other is refused before anything starts.
   */
  private cannotRun(mode: PermissionMode): string {
    const agent = defaultAgentOf(this.client.config);
    const tested = this.tested[commandLineOf(agent)];
    if (mode !== "full" && tested?.passed === false) {
      return `${agent.label} ${tested.detail} when its permissions were tested, at version ${tested.version}, so it cannot be limited: it runs only with full access until it passes the test`;
    }
    return this.runnerFor(agent).cannotHonour(mode);
  }

  /** Run the permission test on one of the user's agents over ACP, and from then on hold it to the modes it passes for. It costs a model call, so it runs only when the user asks; stopping the session ends it. */
  public async testPermissions(id: string): Promise<Check> {
    const agent = this.client.config.agents.find((each) => each.id === id);
    if (agent?.protocol !== "acp") {
      throw new PlayerTwoError(agent === undefined ? `you have no agent ${id}` : `${agent.label} runs as a single command and asks nothing: there is nothing to test`);
    }
    const testing = testPermissions(this.client.home, agent, this.stopping.signal);
    this.testing.add(testing);
    try {
      return await testing;
    } finally {
      this.testing.delete(testing);
      this.tested = permissionTests(this.client.home);
      this.hooks.changed();
    }
  }

  /**
   * The mode the user's own requests of their own agents run at: `ownMode`, or else the most below it that the agent that answers can keep, as Cursor's one-shot command keeps read-only and nothing
   * between that and full. When it can keep none, `ownMode` itself, which the run is then refused at.
   */
  private ownMode(): PermissionMode {
    const { ownMode } = this.client.config;
    return MODES.toReversed().find((mode) => atMost(mode, ownMode) && this.cannotRun(mode) === "") ?? ownMode;
  }

  /**
   * The checkout a run of the user's agent in `repo` at `mode` goes in, by their own say or under the grant `grant` names; or why it cannot run: there is none, it is held back,
   * or the agent that answers cannot be held to the mode, saying which setting would let it run.
   */
  private runnable(repo: string, mode: PermissionMode, grant: string | null): Checkout {
    const checkout = this.checkouts.get(repo);
    if (checkout === undefined) {
      throw new PlayerTwoError(`there is no checkout of ${repo} under ${this.dev}`);
    }
    if (this.isHeld(repo)) {
      throw new PlayerTwoError(`you hold back your ${repo} agent, so it answers nobody: let it answer on My agents first`);
    }
    const why = this.cannotRun(mode);
    if (why !== "") {
      throw new PlayerTwoError(`${why}. To run it ${mode}, make an agent spoken to over ACP, such as Cursor or Copilot, the one that answers on the Setup page, or run it with full access`);
    }
    const agent = defaultAgentOf(this.client.config);
    // With nobody watching, an agent over ACP is held to a mode only once it has shown it asks; one the user starts is theirs to watch, and the window says it is untested.
    if (grant !== null && mode !== "full" && agent.protocol === "acp" && this.tested[commandLineOf(agent)]?.passed !== true) {
      throw new PlayerTwoError(`${agent.label}'s permissions have not been tested, so nothing shows it keeps to ${mode} with nobody watching. Run Test permissions on the Setup page`);
    }
    return checkout;
  }

  /**
   * Whether everyone a request runs on the say of is the user: a message of theirs, or another agent's request that came from them through agents of theirs alone. Only such a run goes in
   * the checkout itself at any mode; anyone else's that may do more than read goes on a clean copy of it, so that nobody else's request touches what the user has not committed.
   */
  private isOwn(message: Message): boolean {
    if (message.delegation === null) {
      return message.entry.event.author === this.me;
    }
    const judged = this.judge(message);
    return judged.ok && judged.people.every((person) => person === this.me);
  }

  /** Refuse a run at `mode` of a request another agent sent, when the log no longer lets it go, or the agents it came through were let do less: whoever lets it run, it never runs above them. */
  private mayGo(message: Message, mode: PermissionMode): void {
    const judged = message.delegation === null ? null : this.judge(message);
    if (judged?.ok === false) {
      throw new PlayerTwoError(`${agentWords(message.entry.event.author, this.me)}'s request may not go: ${judged.reason}`);
    }
    if (judged !== null && !atMost(mode, judged.mode)) {
      throw new PlayerTwoError(`${agentWords(message.entry.event.author, this.me)}'s request may run at most ${judged.mode}, as no agent it came through was let do more`);
    }
  }

  /**
   * Start a run at `mode`, by the user's own say or under the grant `grant` names, unless it cannot run (see `runnable`): then refuse it, before anything is told to the chat.
   * With `delegate` the agent may ask other agents in it, when its owner let it go and it is spoken to over ACP, whose MCP server is the way it asks.
   */
  private startRun(message: Message, repo: string, post: boolean, mode: PermissionMode, grant: string | null, delegate: boolean): void {
    const key = runOf(message.entry.event.id, repo);
    if (this.runs.has(key)) {
      return;
    }
    const checkout = this.runnable(repo, mode, grant);
    this.mayGo(message, mode);
    const agent = defaultAgentOf(this.client.config);
    const tools = grant !== null ? "none" : agent.protocol === "acp" ? "mcp" : "command"; // Under a grant nobody reviews what the agent hands its asker from the owner's chats: see `work`.
    const prompt = agentPrompt(message, this.me, repo, this.chats.earlier(message), !post, tools);
    const delegates = delegate && grant === null && agent.protocol === "acp";
    const copy = mode !== "read-only" && !this.isOwn(message);
    // A reply in a thread from the same asker to the same agent goes on in the session the thread's last such request left open, if one is and it ran at the same mode and delivery:
    // an agent may have made its own session more permissive than another mode allows, and was told who reads its reply; and one the user let go was given Player Two's tools, which a grant's is not.
    // A run let ask other agents neither goes on in one nor leaves one: its MCP server asks under the request it was started for, which a follow-up is not. Nor does a run on a clean copy,
    // which is removed when it ends.
    const followUp =
      delegates || copy
        ? undefined
        : { key: [message.root ?? message.entry.event.id, message.entry.event.author, repo, mode, post ? "post" : "review", grant === null ? "owner" : "grant"].join(" "), text: message.text };
    const run: AgentRun = {
      entry: message.entry,
      repo,
      post,
      mode,
      agent: agent.label,
      grant,
      delegate: delegates,
      copy,
      accepting: true,
      cancel: new AbortController(),
      startedAt: Date.now(),
      done: Promise.resolve(),
      doing: "",
      told: "",
      clock: null,
      held: false,
      toldAt: 0,
      telling: undefined,
      tellAt: 0
    };
    this.runs.set(key, run);
    this.keepFeed(key, chatOf(message.entry.event, this.me)); // Now, so that the line saying it runs never shows an earlier run's steps under it while git is asked where it stands.
    run.done = this.work(key, run, checkout, this.runnerFor(agent), prompt, followUp);
    this.hooks.changed();
  }

  /** The runner for the agent that answers: the one already made while that agent is unchanged, whose sessions kept for follow-ups are then still good. */
  private runnerFor(agent: Agent): AgentRunner {
    const which = JSON.stringify(agent);
    if (this.agentRunner?.which !== which) {
      this.retire().catch(() => undefined); // It cannot fail: it waits for the agents to go.
      this.agentRunner = { which, runner: agent.protocol === "acp" ? acpRunner(agent, { limit: this.limit }) : oneshotRunner(agent, this.runner) };
    }
    return this.agentRunner.runner;
  }

  /** Close the runner of an agent that no longer answers, ending its sessions kept for follow-ups. */
  private retire(): Promise<void> {
    const retired = this.agentRunner?.runner.close() ?? Promise.resolve();
    this.agentRunner = null;
    return retired;
  }

  /**
   * Tell the chat what the agent is doing, in job.progress's few coarse words and never more: at most once every PROGRESS seconds, and only when it has changed since the chat was last told;
   * and, unchanged, HEARTBEAT seconds after it was last told, for as long as the run goes on, so that teammates go on believing a run that waits on its owner for longer than STALE.
   * Best effort: a teammate misses one line.
   */
  private progress(key: string, doing: Summary): void {
    const run = this.runs.get(key);
    if (run !== undefined) {
      run.doing = doing;
      this.tellAt(key, run.toldAt + this.progressEvery * 1000);
    }
  }

  /** Tell the chat what a run is doing at `at`, Unix milliseconds, unless it is to be told sooner already; then again HEARTBEAT seconds after it was last told. The run's end takes the timer down: see `work`. */
  private tellAt(key: string, at: number): void {
    const run = this.runs.get(key);
    if (run === undefined || (run.telling !== undefined && run.tellAt <= at)) {
      return;
    }
    clearTimeout(run.telling);
    run.tellAt = at;
    run.telling = setTimeout(
      () => {
        run.telling = undefined;
        if (run.doing !== "" && (run.doing !== run.told || Date.now() - run.toldAt >= this.heartbeat * 1000)) {
          run.told = run.doing;
          run.toldAt = Date.now();
          this.agentOf(run.repo)
            .publish(chatOf(run.entry.event, this.me), "job.progress", { repo: run.repo, summary: run.doing }, [run.entry.event.id])
            .catch(() => undefined);
        }
        this.tellAt(key, run.toldAt + this.heartbeat * 1000);
      },
      Math.max(0, at - Date.now())
    );
  }

  /**
   * Start a run's activity afresh, in place of what an earlier run on the same request kept.
   * ponytail: what runs that have ended did is kept for the newest FEEDS of them, whatever chat they were in; keep it for the open chat's alone if that holds too much.
   */
  private keepFeed(key: string, chat: string): void {
    this.feeds.delete(key);
    this.feeds.set(key, { chat, items: [] });
    const ended = [...this.feeds.keys()].filter((each) => !this.runs.has(each));
    for (const old of ended.slice(0, Math.max(0, ended.length - FEEDS))) {
      this.feeds.delete(old);
    }
  }

  /**
   * One step of a run, from its runner or how it started and ended: kept in the run's activity, new or in place of the item with its id, and with it what the agent is doing,
   * when it says, in the coarse words the chat is told.
   */
  private noted(key: string, item: ActivityItem, doing?: Summary): void {
    const items = this.feeds.get(key)?.items;
    if (items !== undefined) {
      const kept = { ...item, run: key };
      const at = items.findIndex((each) => each.id === item.id);
      if (at === -1) {
        items.push(kept);
        items.splice(0, items.length - ITEMS);
      } else {
        items[at] = kept;
      }
      this.hooks.changed();
    }
    if (doing !== undefined) {
      this.progress(key, doing);
    }
  }

  /**
   * Put an agent's ask to its owner, in the view and, for when they are not looking, as an arrival, and wait for their answer. An ask nobody waits for any more, `gone`, as when the agent
   * takes it back or its run is stopped, goes from the view, and answering it then says so; a run that ends first takes its asks with it: see `work`.
   */
  private askOwner(key: string, chat: string, repo: string, ask: PermissionAsk, gone: AbortSignal): Promise<Answer> {
    return new Promise((answer) => {
      this.asked += 1;
      const id = String(this.asked);
      this.waiting.set(id, { run: key, chat, ask, answer });
      gone.addEventListener(
        "abort",
        () => {
          this.waiting.delete(id);
          this.hooks.changed();
        },
        { once: true }
      );
      this.hooks.arrived({ chat, title: `Your ${repo} agent is waiting for your answer`, body: oneLine(ask.title, 120), forMe: true, rings: true });
      this.hooks.changed();
    });
  }

  /**
   * Tell the chat the user let the agent run, on which branch and commit, then run it and see its answer to where it belongs. Never rejects: every way a run can end is told to the user.
   * Nothing runs until the chat has been told: when that cannot be published, the agent does not start. Once it has, the chat hears one ending: the answer (now, or when the draft is sent, or a decline when it is thrown away), a failure, or a stop.
   */
  private async work(key: string, run: AgentRun, checkout: Checkout, runner: AgentRunner, prompt: string, followUp: FollowUp | undefined): Promise<void> {
    const { entry, repo } = run;
    const chat = chatOf(entry.event, this.me);
    const handlers: RunHandlers = {
      activity: (item, doing) => {
        this.noted(key, item, doing);
      },
      permission: (ask, gone) => this.askOwner(key, chat, repo, ask, gone),
      hold: (limit) => {
        const going = this.runs.get(key); // The same run.
        if (going !== undefined) {
          going.clock = limit;
          this.holdFor(key);
        }
      }
    };
    const request = [entry.event.id];
    const stopped = (): boolean => run.cancel.signal.aborted; // Asked afresh each time: the user may stop it while this waits.
    let head: Head;
    let copy: Worktree | null;
    let hour: NodeJS.Timeout | undefined;
    try {
      ({ head, copy } = await this.begin(key, run, checkout, chat));
      this.noted(key, startedItem(run.agent, run.mode));
      hour = this.hourOf(run);
    } catch (error) {
      const title = run.grant === null ? `your ${repo} agent did not start` : `your ${repo} agent did not run ${entry.event.author}'s request under your grant`;
      this.hooks.notice(error instanceof AgentCancelledError ? { title: "", body: error.message, severity: "info" } : { title, body: problemOf(error), severity: "error" });
      this.runs.delete(key);
      this.hooks.changed();
      return;
    }
    let ending = "";
    let ended = endedItem("answered");
    try {
      if (stopped()) {
        throw new AgentCancelledError("stopped"); // While the chat was being told: it ends as stopped, without the agent being started only to be killed.
      }
      const text = fitText(await runner.run(prompt, copy?.path ?? checkout.path, run.mode, handlers, run.cancel.signal, followUp, ...this.toolsOf(run)));
      if (text === "") {
        ending = "the agent returned nothing";
        ended = endedItem("failed", ending);
      } else {
        const handed = await this.handOver(copy, checkout, head.branch, text);
        copy = handed.copy; // None when it is kept.
        const draft = { text: handed.text, entry, repo, branch: head.branch, patch: handed.patch };
        await (run.post ? this.postAnswer(chat, draft) : this.keepDraft(chat, draft));
      }
    } catch (error) {
      ending = error instanceof AgentCancelledError ? "stopped" : problemOf(error);
      ended = endedBy(error);
    }
    await this.throwAway(copy);
    this.noted(key, ended);
    await this.tellEnding(chat, repo, request, ending);
    clearTimeout(run.telling);
    clearTimeout(hour);
    await this.withdrawChildren(run, chat);
    for (const [id, waiting] of this.waiting) {
      if (waiting.run === key) {
        this.waiting.delete(id); // Nobody is asking any more: the runner stopped waiting for it when the run ended.
        waiting.answer("refuse");
      }
    }
    this.runs.delete(key);
    this.hooks.changed();
  }

  /**
   * Ask git where the checkout stands, make the clean copy a run on one goes in, and tell the chat the run goes ahead; or reject, leaving no copy behind, when any of that cannot be done,
   * or the run was stopped meanwhile. A run on a clean copy is accepted as on the commit the copy was made at, with nothing uncommitted.
   */
  private async begin(key: string, run: AgentRun, checkout: Checkout, chat: string): Promise<{ readonly head: Head; readonly copy: Worktree | null }> {
    const found = await this.describe(checkout);
    // Named for the run, its request and repo, as one request may tag two of the user's agents.
    const copy = run.copy ? await worktree.open(checkout.path, createHash("sha256").update(key).digest("hex")) : null;
    const head = copy === null ? found : { branch: found.branch, commit: copy.base, dirty: false };
    try {
      await this.register([checkout]); // The run is given the file its key is in, which may have been replaced since the last beat.
      await this.testedVersion(run);
      if (run.cancel.signal.aborted) {
        throw new AgentCancelledError(`Stopped your ${run.repo} agent before it started.`); // While git was asked where the checkout stands: nothing ran, so the chat hears nothing.
      }
      await this.accept(key, run, chat, head);
    } catch (error) {
      await this.throwAway(copy);
      throw error;
    }
    return { head, copy };
  }

  /**
   * What a run's answer goes with: the patch of what its clean copy changed, titled with the answer's first line, and the copy, to be thrown away; no patch when it changed nothing, or ran
   * in the checkout. A change too large for a patch event, or one git cannot write as a diff a patch carries, is not sent: the answer says so, the copy is kept, locked, and not handed
   * back to be thrown away, and the owner is told where it is.
   */
  private async handOver(
    copy: Worktree | null,
    checkout: Checkout,
    branch: string,
    text: string
  ): Promise<{ readonly text: string; readonly patch: ContentOf<"patch"> | null; readonly copy: Worktree | null }> {
    if (copy === null) {
      return { text, patch: null, copy };
    }
    let said = "The change was too large to send as a patch."; // In the answer, for whoever asked.
    let why: string; // For the owner.
    try {
      const diff = await worktree.collect(copy);
      const first = oneLine(text.trim().split("\n")[0] ?? "", 80);
      const patch = { repo: refOf(checkout.remote), base: copy.base, branch, title: first === "" ? "A change" : first, diff };
      // Counted as the hub counts an event's content: the diff written as JSON, with the rest of the patch, by code point.
      if (diff === "" || Array.from(JSON.stringify(patch)).length <= MAX_PATCH) {
        return { text, patch: diff === "" ? null : patch, copy };
      }
      why = `Its diff is ${String(diff.length)} characters, more than the ${String(MAX_PATCH)} a patch carries`;
    } catch (error) {
      said = "The change could not be sent as a patch.";
      why = problemOf(error);
    }
    await worktree.lock(copy).catch(() => undefined); // Unlocked, it is there all the same until the desk next starts.
    this.hooks.notice({
      title: `your ${checkout.remote.name} agent's change was not sent as a patch`,
      body: `${why}. It is kept in ${copy.path}, made from ${copy.base.slice(0, 7)}: what is in it is the agent's, so read it before you run anything there. Once you are done with it: git -C ${checkout.path} worktree remove -f -f ${copy.path}`,
      severity: "error"
    });
    return { text: fitText(`${text}\n\n(${said})`), patch: null, copy: null };
  }

  /** Tell the chat, and the user, how a run on `request` that did not answer ended, `ending`: "stopped", or why it failed. Nothing for "", a run that answered. Best effort: the chat misses one line. */
  private async tellEnding(chat: string, repo: string, request: readonly string[], ending: string): Promise<void> {
    if (ending === "stopped") {
      await this.agentOf(repo)
        .publish(chat, "job.cancelled", { repo }, request)
        .catch(() => undefined);
      this.hooks.notice({ title: "", body: `Stopped your ${repo} agent.`, severity: "info" });
    } else if (ending !== "") {
      await this.agentOf(repo)
        .publish(chat, "job.error", { repo }, request)
        .catch(() => undefined); // Only the fact: what the agent printed on the way down may not be fit to share.
      this.hooks.notice({ title: `your ${repo} agent`, body: ending, severity: "error" });
    }
  }

  /** Remove a run's clean copy once it is done with. Best effort: one left behind is removed when the desk next starts (see `sweep` in worktree.ts). */
  private async throwAway(copy: Worktree | null): Promise<void> {
    if (copy !== null) {
      await worktree.close(copy).catch(() => undefined);
    }
  }

  /**
   * What a run's agent is told of who it is, and the request its MCP server asks other agents under when it may, which its environment names too: the server asks under no other,
   * so no other run of the agent asks under this one. Under a grant the command reads only the request's chat, and there is no MCP server: nothing hands it the owner's other chats,
   * and nothing asks other agents in their name with nobody watching. It runs as their user all the same, the honest edge.
   */
  private toolsOf(run: AgentRun): [Readonly<Record<string, string>>, string | undefined] {
    const chat = run.grant === null ? undefined : chatOf(run.entry.event, this.me);
    const job = run.delegate ? run.entry.event.id : undefined;
    return [agentEnv(this.client.home, this.me, run.repo, chat, job), job];
  }

  /** The jobs a run's agent asked that have not ended, waiting for their owners or at work, as request id and agent. */
  private openChildren(run: AgentRun): { readonly id: string; readonly agent: string }[] {
    const { id, kind, refs } = run.entry.event;
    const job = jobIn(this.chats.tree(kind === "job.request" ? (refs[0] ?? "") : id), id, `${this.me}/${run.repo}`);
    return (job?.children ?? []).flatMap(({ request, agent }) => {
      const asked = this.chats.message(request.event.id);
      const state = asked === null ? undefined : this.chats.requests(asked, this.client.now()).find((each) => `${each.owner}/${each.repo}` === agent)?.state;
      return state === "waiting" || state === "working" ? [{ id: request.event.id, agent }] : [];
    });
  }

  /**
   * Why a run in a tree is no longer wanted: its asker took its request back, as a person may one whose agent is let ask others and an agent does what it asked once its own run ends;
   * or, for an agent's request, the log no longer lets it go, as when the job that asked it has ended or been taken back. Null while it is wanted, and for any other run.
   */
  private unwanted(run: AgentRun): string | null {
    const { event } = run.entry;
    const agent = `${this.me}/${run.repo}`;
    if (!run.delegate && event.kind !== "job.request") {
      return null;
    }
    const takenBack = this.chats.log(event.id).some(({ trusted, event: other }) => {
      const said = readContent(other);
      return trusted && said.kind === "job.withdrawn" && said.content.agent === agent && other.refs[0] === event.id && other.author === event.author;
    });
    if (takenBack) {
      return `${event.kind === "job.request" ? agentWords(event.author, this.me) : event.author} took the request back`;
    }
    const message = event.kind === "job.request" ? this.chats.message(event.id) : null;
    const judged = message === null ? null : this.judge(message);
    return judged?.ok === false ? `the request may no longer go: ${judged.reason}` : null;
  }

  /** Stop a run in a tree that is no longer wanted (see `unwanted`), saying why; its end then takes back what it asked in turn. */
  private stopUnwanted(key: string): void {
    const run = this.runs.get(key);
    const why = run === undefined || run.cancel.signal.aborted ? null : this.unwanted(run);
    if (run !== undefined && why !== null) {
      this.hooks.notice({ title: `your ${run.repo} agent was stopped`, body: `${why}.`, severity: "info" });
      run.cancel.abort();
    }
  }

  /** Stop a run's time limit while an agent it asked has not ended, and start it again once none is open: time spent waiting on them is not the agent's own. */
  private holdFor(key: string): void {
    const run = this.runs.get(key);
    const open = run?.delegate === true && this.openChildren(run).length > 0;
    if (run !== undefined && run.clock !== null && open !== run.held) {
      run.held = open;
      if (open) {
        run.clock.pause();
      } else {
        run.clock.resume();
      }
    }
  }

  /**
   * A timer that stops a run in a tree once its root's time is up by this desk's clock, whatever is still waiting: a run let ask other agents on a person's request, the root of all it
   * asks, `rootTime` after it was let go; and a run on an agent's request `rootTime` after the root's agent was last let run, as the log has it, so that every desk in a tree holds
   * its own run to the root's time, the root's desk there or not. Its end then withdraws what it asked (see `withdrawChildren`). A run whose clock `holdFor` holds is one of these,
   * so none is held past it. Undefined for any other run, and for one on a request the log no longer lets go, which is stopped as the log is next read (see `unwanted`).
   */
  private hourOf(run: AgentRun): NodeJS.Timeout | undefined {
    const { event } = run.entry;
    const asked = event.kind === "job.request" ? this.chats.message(event.id) : null;
    const judged = asked === null ? null : this.judge(asked);
    let left: number;
    let since: string; // When the time began, for the notice.
    if (judged?.ok === true) {
      left = judged.since + this.rootTime - this.client.now();
      since = `${asked?.delegation?.first ?? "someone"}'s request, which it was asked under, was let run`;
    } else if (run.delegate && event.kind === "message") {
      left = this.rootTime;
      since = `it was let ask other agents on ${event.author}'s request`;
    } else {
      return undefined;
    }
    return setTimeout(
      () => {
        this.hooks.notice({ title: `your ${run.repo} agent ran out of time`, body: `${this.minutes()} minutes have passed since ${since}.`, severity: "info" });
        run.cancel.abort();
      },
      Math.max(0, left) * 1000
    );
  }

  /** Once a run let ask other agents has ended, however it ended, take back what its agent asked that has not ended, signed by the agent that asked. Best effort, as any job's end is. */
  private async withdrawChildren(run: AgentRun, chat: string): Promise<void> {
    for (const child of run.delegate ? this.openChildren(run) : []) {
      await this.agentOf(run.repo)
        .publish(chat, "job.withdrawn", { agent: child.agent }, [child.id])
        .catch(() => undefined);
    }
  }

  /**
   * Under a grant below full, an agent over ACP must be the version that passed its permission test, when the test recorded one, as an update may have changed whether it asks.
   * It is asked by starting it, as the setup check does, which costs no model call; a stopping desk ends it.
   */
  private async testedVersion({ grant, mode }: AgentRun): Promise<void> {
    const agent = defaultAgentOf(this.client.config);
    const tested = this.tested[commandLineOf(agent)];
    if (grant === null || mode === "full" || agent.protocol !== "acp" || tested === undefined || tested.version === "") {
      return;
    }
    const version = await greet(agent, ACP_TIMEOUT, this.stopping.signal);
    if (version !== tested.version) {
      throw new PlayerTwoError(
        `${agent.label} is version ${version === "" ? "unknown" : version} now, and passed its permission test at version ${tested.version}. Run Test permissions on the Setup page again`
      );
    }
  }

  /**
   * Tell the chat a run goes ahead: on which branch and commit, at which mode and delivery, whether its agent may ask other agents, and who let it, its owner or a grant of theirs,
   * which then counts it from the log.
   */
  private async accept(key: string, run: AgentRun, chat: string, head: Head): Promise<void> {
    const by = run.grant === null ? "owner" : { grant: run.grant };
    const content: ContentOf<"job.accepted"> = { repo: run.repo, ...head, delivery: run.post ? "post" : "review", mode: run.mode, delegate: run.delegate, by };
    const accepted = await this.client.publish(chat, "job.accepted", content, [run.entry.event.id]);
    this.keep([{ ...accepted, trusted: true }]);
    const going = this.runs.get(key); // The same run: counted from the log from now on, and no longer as one the log does not hold.
    if (going !== undefined) {
      going.accepting = false;
    }
  }

  /** The client that signs as my agent in `repo`, with the key everyone was told of: a run's own reports, and an answer nobody reviewed, are the agent's to sign. */
  private agentOf(repo: string): Client {
    return this.client.as(`${this.me}/${repo}`, this.agentKeys.get(repo) ?? agentKey(this.client.home, repo));
  }

  /**
   * Post an answer nobody reviewed, and before it the patch that goes with it, each signed by the agent that wrote it; or when they cannot be, or either holds one of the user's private keys,
   * keep what was not posted as a draft for its owner to review and send under their own name. A key in an answer would let whoever reads it sign as them or their agent, a grant in their
   * name among what it could sign.
   */
  private async postAnswer(chat: string, draft: Draft): Promise<void> {
    const inText = keyIn(this.client.home, draft.text);
    const leaked = inText ?? (draft.patch === null ? null : keyIn(this.client.home, `${draft.patch.title}\n${draft.patch.diff}`));
    if (leaked !== null) {
      const body = `${inText === null ? "The change that goes with it" : "It"} holds the private key in ${leaked}, which would let whoever reads it sign as its owner. Read it before you send it: the agent read that file, and may have put the key elsewhere too.`;
      this.hooks.notice({ title: `your ${draft.repo} agent's answer was not posted; it is kept as a draft`, body, severity: "error" });
      await this.keepDraft(chat, draft);
      return;
    }
    let patch = draft.patch;
    try {
      if (patch !== null) {
        await this.agentOf(draft.repo).publish(chat, "patch", patch, [draft.entry.event.id]);
        patch = null; // Posted: should the answer not be, the draft kept is the answer alone.
      }
      await this.agentOf(draft.repo).publish(chat, "job.result", { repo: draft.repo, branch: draft.branch, text: draft.text, reviewed: false }, [draft.entry.event.id]);
    } catch (error) {
      // An answer that could not be posted is kept as a draft, so the agent's work is not lost.
      this.hooks.notice({ title: `your ${draft.repo} agent's answer was not posted; it is kept as a draft`, body: problemOf(error), severity: "error" });
      await this.keepDraft(chat, { ...draft, patch });
    }
  }

  /** Hold an answer for its owner to review; or, when the desk is quitting and nobody will, throw it away, so the chat still hears how the run ended. */
  private async keepDraft(chat: string, draft: Draft): Promise<void> {
    if (this.stopping.signal.aborted) {
      await this.decline(draft.entry.event.id, draft.repo);
      return;
    }
    this.drafts.set(chat, [...(this.drafts.get(chat) ?? []), draft]);
    this.hooks.arrived({ chat, title: `Your ${draft.repo} agent's draft is ready to review`, body: oneLine(draft.text, 120), forMe: true, rings: true });
  }
}
