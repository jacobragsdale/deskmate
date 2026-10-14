/** What crosses between the desk and the window: the state the window draws, the commands it may send back, and every line of the protocol the two processes speak. */

import { z } from "zod";

import { teamRepoSchema } from "../core/wire.ts";

/** Where one tagged agent stands, already worked out for the reader: `mine` says whether it is their own agent. */
const requestSchema = z
  .strictObject({
    noteId: z.int(),
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
      z.strictObject({ kind: z.literal("stopped") })
    ])
  })
  .readonly();

const messageSchema = z
  .strictObject({
    id: z.int(),
    sender: z.string(),
    agent: z.string().nullable(), // The repo the sender's agent worked in; null when the sender typed it.
    branch: z.string(), // The branch that agent was on; "" when unknown.
    ts: z.int(),
    trusted: z.boolean(),
    body: z.string(), // "" when the note failed its signature check: its text never reaches the window.
    quote: z.string(), // The note this one answers, on one line; "" when it answers nothing.
    header: z.boolean(), // Whether to say who wrote it, or let it sit under the previous note's header.
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
    pinned: z.strictObject({ name: z.string(), have: z.int(), mine: z.boolean() }).nullable(), // The repo the channel is about, how many members have it, and whether I do.
    newAfter: z.int().nullable(), // Notes after this id arrived while the user was elsewhere.
    messages: z.array(messageSchema).readonly(),
    drafts: z.array(z.strictObject({ noteId: z.int(), repo: z.string(), asker: z.string(), text: z.string() }).readonly()).readonly(), // Answers waiting for review, oldest first.
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

/** Everything the window may ask the desk to do. Parsed on both sides of the line before anything acts on it. */
export const commandSchema = z.discriminatedUnion("do", [
  z.strictObject({ do: z.literal("join"), hub: z.string().max(500), name: z.string().max(40), token: z.string().max(500), agent: z.string().max(500) }),
  z.strictObject({ do: z.literal("open"), chat }),
  z.strictObject({ do: z.literal("send"), chat, text: z.string().min(1) }),
  z.strictObject({ do: z.literal("sendDraft"), chat, noteId: z.int(), repo, text: z.string().min(1) }),
  z.strictObject({ do: z.literal("discardDraft"), chat, noteId: z.int(), repo }),
  z.strictObject({ do: z.literal("run"), noteId: z.int(), repo, post: z.boolean() }),
  z.strictObject({ do: z.literal("stop"), noteId: z.int(), repo }),
  z.strictObject({ do: z.literal("decline"), noteId: z.int(), repo }),
  z.strictObject({ do: z.literal("joinChannel"), name: z.string().max(40) }),
  z.strictObject({ do: z.literal("leaveChannel"), chat }),
  z.strictObject({ do: z.literal("pin"), chat, repo }),
  z.strictObject({ do: z.literal("unpin"), chat }),
  z.strictObject({ do: z.literal("clone"), repo })
]);

/** How a command ended. A problem is worded for the user. */
export const outcomeSchema = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true) }), z.strictObject({ ok: z.literal(false), problem: z.string() })]);

/** Something to tell the user that is not part of the picture: a failure, or that a long job has started or finished. */
export const noticeSchema = z.strictObject({ title: z.string(), body: z.string(), severity: z.enum(["info", "error"]) }).readonly();

/** A note from someone else, or a draft ready for review: something the user may want to be told about while they are looking elsewhere. */
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
export type Command = z.infer<typeof commandSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type Notice = z.infer<typeof noticeSchema>;
export type Arrival = z.infer<typeof arrivalSchema>;
export type Question = z.infer<typeof questionSchema>;
export type DeskLine = z.infer<typeof deskLineSchema>;
export type WindowLine = z.infer<typeof windowLineSchema>;

/** The narrow set of calls the preload script gives the window. */
export interface Bridge {
  readonly view: () => Promise<unknown>;
  readonly command: (command: Command) => Promise<unknown>;
  readonly onView: (listener: (view: unknown) => void) => () => void;
  readonly onNotice: (listener: (notice: unknown) => void) => () => void;
}
