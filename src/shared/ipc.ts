/** What crosses between the main process and the window: the state the window draws, and the commands it may send back. */

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
      current: currentSchema.nullable()
    })
    .readonly()
]);

const chat = z.string().min(1).max(40);
const repo = z.string().min(1).max(64);

/** Everything the window may ask the main process to do. Parsed there before anything acts on it. */
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

export type RequestView = z.infer<typeof requestSchema>;
export type MessageView = z.infer<typeof messageSchema>;
export type RowView = z.infer<typeof rowSchema>;
export type CurrentView = z.infer<typeof currentSchema>;
export type View = z.infer<typeof viewSchema>;
export type ChatView = Extract<View, { kind: "chat" }>;
export type Command = z.infer<typeof commandSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type Notice = z.infer<typeof noticeSchema>;

/** The narrow set of calls the preload script gives the window. */
export interface Bridge {
  readonly view: () => Promise<unknown>;
  readonly command: (command: Command) => Promise<unknown>;
  readonly onView: (listener: (view: unknown) => void) => () => void;
  readonly onNotice: (listener: (notice: unknown) => void) => () => void;
}
