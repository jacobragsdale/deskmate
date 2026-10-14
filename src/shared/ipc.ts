/** What crosses between the desk and the window: the state the window draws, the commands it may send back, and every line of the protocol the two processes speak. */

import { z } from "zod";

import { teamRepoSchema } from "../core/wire.ts";

/** The agents the join form offers, as the one-shot commands the prompt is added to as the last argument. The first is the default; any other is typed in as "Other". */
export const AGENT_CHOICES = [
  { label: "Cursor", command: "agent -p --output-format text" },
  { label: "Copilot", command: "copilot -s --allow-all-tools --no-ask-user -p" }
] as const;

/** Where one tagged agent stands, already worked out for the reader: `mine` says whether it is their own agent. `id` is the request's. */
const requestSchema = z
  .strictObject({
    id: z.string(),
    owner: z.string(),
    repo: z.string(),
    mine: z.boolean(),
    status: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("drafted") }), // Mine: an answer is waiting for my review.
      z.strictObject({ kind: z.literal("running"), startedAt: z.number(), branch: z.string() }), // Mine: at work since `startedAt`, Unix milliseconds.
      z.strictObject({ kind: z.literal("noCheckout") }), // Mine: I have no copy of the repo.
      z.strictObject({ kind: z.literal("ready"), before: z.enum(["", "declined", "failed", "stopped", "interrupted"]), canDecline: z.boolean() }), // Mine: I can run it.
      z.strictObject({ kind: z.literal("working"), branch: z.string() }),
      z.strictObject({ kind: z.literal("waiting"), away: z.boolean() }),
      z.strictObject({ kind: z.literal("nobody") }), // Nobody of that name has joined.
      z.strictObject({ kind: z.literal("lacksRepo") }), // Its owner has no copy of the repo.
      z.strictObject({ kind: z.literal("declined") }),
      z.strictObject({ kind: z.literal("failed") }),
      z.strictObject({ kind: z.literal("stopped") }),
      z.strictObject({ kind: z.literal("withdrawn") }) // Whoever asked took it back before it ran.
    ])
  })
  .readonly();

const messageSchema = z
  .strictObject({
    id: z.string(), // The event's id: what a command about it names.
    seq: z.int(), // Its place in the hub's log, which is the order a chat is in.
    sender: z.string(),
    agent: z.string().nullable(), // The repo the sender's agent worked in; null when the sender typed it.
    branch: z.string(), // The branch that agent was on; "" when unknown.
    ts: z.int(),
    trusted: z.boolean(),
    body: z.string(), // "" when the message failed its signature check: its text never reaches the window.
    quote: z.string(), // The request an answer is to, on one line; "" when it answers nothing.
    header: z.boolean(), // Whether to say who wrote it, or let it sit under the previous message's header.
    requests: z.array(requestSchema).readonly()
  })
  .readonly();

const rowSchema = z
  .strictObject({
    chat: z.string(),
    unread: z.int(),
    mark: z.enum(["", "working", "draft", "asked"]),
    here: z.boolean().nullable() // Whether the person is here now; null for a channel.
  })
  .readonly();

const currentSchema = z
  .strictObject({
    chat: z.string(),
    members: z.array(z.string()).readonly().nullable(), // Null for a direct chat.
    joined: z.boolean(),
    hasOlder: z.boolean(), // Whether there may be events before the oldest shown: the "older" command loads them.
    pinned: z.strictObject({ name: z.string(), have: z.int(), mine: z.boolean() }).nullable(), // The repo the channel is about, how many members have it, and whether I do.
    newAfter: z.int().nullable(), // Messages after this seq arrived while the user was elsewhere.
    messages: z.array(messageSchema).readonly(),
    drafts: z.array(z.strictObject({ id: z.string(), repo: z.string(), asker: z.string(), text: z.string() }).readonly()).readonly(), // Answers waiting for review, oldest first, each with its request's id.
    running: z.boolean() // Whether one of the user's agents is at work here.
  })
  .readonly();

export const viewSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("setup"), defaultAgent: z.string() }).readonly(), // Nobody has joined a hub from this machine yet.
  z.strictObject({ kind: z.literal("stopped"), problem: z.string() }).readonly(), // The desk has gone and will not start again. The window makes this one itself: there is no desk to send it.
  z
    .strictObject({
      kind: z.literal("chat"),
      me: z.string(),
      hub: z.string(),
      agent: z.string(),
      dev: z.string(),
      link: z.discriminatedUnion("state", [
        z.strictObject({ state: z.literal("connecting") }),
        z.strictObject({ state: z.literal("connected") }),
        z.strictObject({ state: z.literal("down"), problem: z.string() })
      ]),
      loaded: z.boolean(),
      rows: z.array(rowSchema).readonly(),
      waiting: z.int(), // Requests waiting for the user's agents, in every chat.
      unread: z.int(),
      team: z.array(teamRepoSchema).readonly(),
      myRepos: z.array(z.string()).readonly(),
      otherChannels: z.array(z.strictObject({ name: z.string(), members: z.array(z.string()).readonly() }).readonly()).readonly(), // Channels the user could join.
      busy: z.strictObject({ working: z.int(), unsent: z.int() }).readonly(), // What quitting now would lose: agents at work and drafts not sent. Here so the window can warn without asking first.
      current: currentSchema.nullable()
    })
    .readonly()
]);

const chat = z.string().min(1).max(40);
const repo = z.string().min(1).max(64);
const id = z.string().regex(/^[0-9a-f]{64}$/); // An event's id: for a job, its request's.

/** Everything the window may ask the desk to do. Parsed on both sides of the line before anything acts on it. */
export const commandSchema = z.discriminatedUnion("do", [
  z.strictObject({ do: z.literal("join"), hub: z.string().max(500), name: z.string().max(40), token: z.string().max(500), agent: z.string().max(500) }),
  z.strictObject({ do: z.literal("open"), chat }),
  z.strictObject({ do: z.literal("send"), chat, text: z.string().min(1) }),
  z.strictObject({ do: z.literal("reply"), root: id, text: z.string().min(1) }), // A message in the thread of the message `root` names. Tags in it work as in any message.
  z.strictObject({ do: z.literal("react"), id, emoji: z.string().min(1).max(32), on: z.boolean() }), // `on: false` takes the user's reaction back.
  z.strictObject({ do: z.literal("edit"), id, text: z.string().min(1) }), // One of the user's own messages. Its tags stay as they were sent.
  z.strictObject({ do: z.literal("delete"), id }), // One of the user's own messages.
  z.strictObject({ do: z.literal("withdraw"), id, owner: z.string(), repo }), // Take back a request of the user's that `owner`'s agent has not started on.
  z.strictObject({ do: z.literal("sendDraft"), chat, id, repo, text: z.string().min(1) }),
  z.strictObject({ do: z.literal("discardDraft"), chat, id, repo }),
  z.strictObject({ do: z.literal("run"), id, repo, post: z.boolean() }),
  z.strictObject({ do: z.literal("stop"), id, repo }),
  z.strictObject({ do: z.literal("decline"), id, repo }),
  z.strictObject({ do: z.literal("joinChannel"), name: z.string().max(40) }),
  z.strictObject({ do: z.literal("leaveChannel"), chat }),
  z.strictObject({ do: z.literal("pin"), chat, repo }),
  z.strictObject({ do: z.literal("unpin"), chat }),
  z.strictObject({ do: z.literal("clone"), repo }),
  z.strictObject({ do: z.literal("older") }), // Load the page before the oldest event shown in the open chat.
  z.strictObject({ do: z.literal("doctor") }) // Run the setup check. The reply's data is the list.
]);

/** One item of the setup check: what was looked at, how it stands, what was found, and the command or instruction that fixes it ("" when there is nothing to do). Nothing runs a fix: the user copies it. */
export const checkSchema = z.strictObject({ id: z.string(), title: z.string(), status: z.enum(["ok", "warn", "fail", "skip"]), detail: z.string(), fix: z.string() }).readonly();

/** How a command ended. A problem is worded for the user. */
export const outcomeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: z.array(checkSchema).readonly().optional() }), // Data only for the setup check: its list.
  z.strictObject({ ok: z.literal(false), problem: z.string() })
]);

/** Something to tell the user that is not part of the picture: a failure, or that a long job has started or finished. */
export const noticeSchema = z.strictObject({ title: z.string(), body: z.string(), severity: z.enum(["info", "error"]) }).readonly();

/** A message or an answer from someone else, or a draft ready for review: something the user may want to be told about while they are looking elsewhere. */
export const arrivalSchema = z
  .strictObject({
    chat: z.string(),
    title: z.string(),
    body: z.string(),
    forMe: z.boolean(), // It tags one of the user's agents, or is their agent's draft: worth showing even when the chat is open.
    rings: z.boolean() // Channel chatter shows as unread without a sound.
  })
  .readonly();

/** A yes or no the desk needs from the user before it goes on, in the desk's words. `confirm` is what the button that says yes reads. */
export const questionSchema = z.strictObject({ message: z.string(), detail: z.string(), confirm: z.string() }).readonly();

/** Every line the desk writes to the window, one JSON object each. */
export const deskLineSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), version: z.string(), protocol: z.int() }), // First, once. Not strict, so a window can still read the protocol of a desk that says more, and tell the user which side to update.
  z.strictObject({ t: z.literal("view"), view: viewSchema }), // The whole of what should be drawn, whenever it has changed.
  z.strictObject({ t: z.literal("notice"), notice: noticeSchema }),
  z.strictObject({ t: z.literal("arrival"), arrival: arrivalSchema }),
  z.strictObject({ t: z.literal("ask"), id: z.int(), question: questionSchema }), // Answered by an `answer` line with the same id.
  z.strictObject({ t: z.literal("reply"), id: z.int(), outcome: outcomeSchema }) // How the command with that id ended. Every command gets exactly one.
]);

/** Every line the window writes to the desk. */
export const windowLineSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("command"), id: z.int(), command: commandSchema }),
  z.strictObject({ t: z.literal("answer"), id: z.int(), ok: z.boolean() }),
  z.strictObject({ t: z.literal("attend"), attentive: z.boolean() }) // Whether the user is looking at the window.
]);

/** One line as its sender wrote it, read with the schema for its direction. Null when it is not a line of the protocol. */
export function readLine<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export type RequestView = z.infer<typeof requestSchema>;
export type MessageView = z.infer<typeof messageSchema>;
export type RowView = z.infer<typeof rowSchema>;
export type CurrentView = z.infer<typeof currentSchema>;
export type View = z.infer<typeof viewSchema>;
export type ChatView = Extract<View, { kind: "chat" }>;
export type Check = z.infer<typeof checkSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type Notice = z.infer<typeof noticeSchema>;
export type Arrival = z.infer<typeof arrivalSchema>;
export type Question = z.infer<typeof questionSchema>;
export type DeskLine = z.infer<typeof deskLineSchema>;
export type WindowLine = z.infer<typeof windowLineSchema>;

/** On Windows, the WSL distributions the setup page offers and the one chosen, null for whichever WSL uses by default. */
export const distroChoiceSchema = z.strictObject({ chosen: z.string().nullable(), names: z.array(z.string()).readonly() }).readonly();

export type DistroChoice = z.infer<typeof distroChoiceSchema>;

/** The narrow set of calls the preload script gives the window. */
export interface Bridge {
  readonly view: () => Promise<unknown>;
  readonly command: (command: Command) => Promise<unknown>;
  readonly onView: (listener: (view: unknown) => void) => () => void;
  readonly onNotice: (listener: (notice: unknown) => void) => () => void;
  readonly doctor: (again: boolean) => Promise<unknown>; // The setup check. With `again`, a desk that is not up is first started afresh.
  readonly distros: () => Promise<unknown>; // A DistroChoice on Windows, and null anywhere else.
  readonly distro: (name: string | null) => Promise<unknown>; // Run the desk in this distribution from now on.
}
