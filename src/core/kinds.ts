/** What an event of each kind this version knows says in its content, and reading it. The hub stores and relays every kind; a reader acts on the ones it knows and passes over the rest. No IO. */

import { z } from "zod";

import { branchSchema, hashSchema, NAME, nameSchema, permissionModeSchema, pubKeySchema, REPO_NAME, repoNameSchema, repoRefSchema } from "./wire.ts";
import type { Event } from "./wire.ts";

// Content travels as a string and the signature covers the string, so reading it with z.object, which passes over a field it does not know, changes nothing that was signed.
// It lets a later phase add a field to a kind without older readers losing the kind. A value this version does not allow, such as a mode it has never heard of, still makes it unreadable.
const nothing = z.object({}).readonly();
const text = z.string().min(1);
const repo = repoNameSchema; // The repo of the agent a job is for. The agent's owner is the event's author.
const agent = z.string().regex(new RegExp(`^${NAME}/${REPO_NAME}$`)); // "owner/repo": one person's checkout's agent.

/** What an agent at work is doing, in the only words job.progress may carry: never a path, a command or anything the agent wrote. */
export const SUMMARIES = ["thinking", "reading", "editing files", "running a command", "waiting for approval"] as const;

export const MAX_GRANT = 30 * 86_400; // Most seconds a grant may last after its event's time.

/** The content of each kind this version knows, tagged with the kind. */
export const contentSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("message"), content: z.object({ text, via: z.enum(["window", "cli", "mcp", "workflow"]) }).readonly() }), // A reply has its thread's root as refs[0].
    z.object({ kind: z.literal("message.edit"), content: z.object({ text }).readonly() }),
    z.object({ kind: z.literal("message.delete"), content: nothing }),
    z.object({ kind: z.literal("reaction"), content: z.object({ emoji: z.string().min(1).max(32), on: z.boolean() }).readonly() }), // `on: false` takes it back.
    z.object({ kind: z.literal("channel.join"), content: nothing }),
    z.object({ kind: z.literal("channel.leave"), content: nothing }),
    z.object({ kind: z.literal("channel.pin"), content: z.object({ repo: repoRefSchema.nullable(), branch: z.null() }).readonly() }), // `repo: null` unpins. A branch from phase 6.
    z.object({
      kind: z.literal("job.accepted"),
      content: z
        .object({
          repo,
          branch: branchSchema,
          commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), // SHA-1, or SHA-256 for a repository that uses it.
          dirty: z.boolean(), // Whether the checkout had changes nobody had committed.
          delivery: z.enum(["review", "post"]),
          mode: permissionModeSchema, // What the owner let the agent do without asking: a run never goes beyond it.
          delegate: z.boolean().default(false), // Phase 5: whether the agent may ask other agents in this run. An acceptance from before has none, and is read as no.
          by: z.union([z.literal("owner"), z.object({ grant: hashSchema }).readonly()]) // Who let it run: its owner by hand, or a grant of theirs, by the grant's event id.
        })
        .readonly()
    }),
    z.object({ kind: z.literal("job.declined"), content: z.object({ repo, reason: z.string() }).readonly() }),
    z.object({ kind: z.literal("job.progress"), content: z.object({ repo, summary: z.enum(SUMMARIES) }).readonly() }), // Coarse, for everyone in the chat.
    z.object({ kind: z.literal("job.result"), content: z.object({ repo, branch: branchSchema, text, reviewed: z.boolean() }).readonly() }),
    z.object({ kind: z.literal("job.error"), content: z.object({ repo }).readonly() }), // Only the fact: why stays with the owner.
    z.object({ kind: z.literal("job.cancelled"), content: z.object({ repo }).readonly() }),
    z.object({ kind: z.literal("job.withdrawn"), content: z.object({ agent: z.string().regex(new RegExp(`^${NAME}/${REPO_NAME}$`)) }).readonly() }),
    z.object({ kind: z.literal("agent.register"), content: z.object({ repo, pubkey: pubKeySchema }).readonly() }), // The key of its author's agent in `repo`, which then signs as "author/repo": the newest wins.
    // An agent at work asking another, from phase 5, authored by the asking agent. refs[0] is the root request, and refs[1] the request the asker is working on: the root again when the asker is the root's agent.
    // `chain` is the agents from the root's down to the asker, in order. src/core/delegation.ts says when one may run.
    z.object({ kind: z.literal("job.request"), content: z.object({ target: agent, text, chain: z.array(agent).min(1).readonly() }).readonly() }),
    // A standing yes from an agent's owner. It is read with its event's time, which bounds how long it may last; src/core/grants.ts says when it applies.
    z
      .object({
        kind: z.literal("grant"),
        content: z
          .object({
            agent: z.string().regex(new RegExp(`^${NAME}/${REPO_NAME}$`)), // One of its author's agents, or it grants nothing.
            askers: z.array(z.union([nameSchema, z.literal("*")])).readonly(), // Names, or "*" for anyone on the hub.
            mode: permissionModeSchema,
            delivery: z.enum(["review", "post"]),
            expires: z.int(), // Unix seconds.
            runsPerDay: z.int().min(1).max(1000)
          })
          .readonly(),
        ts: z.int()
      })
      .refine(({ content, ts }) => content.expires <= ts + MAX_GRANT, { message: "a grant lasts at most 30 days", path: ["content", "expires"] }),
    z.object({ kind: z.literal("grant.revoke"), content: nothing }) // refs[0] is the grant. Counts only from the grant's author.
  ])
  .readonly();

/**
 * The kinds an agent may author: its run's own reports, and from phase 5 a request of another agent and taking one back. Everything else, a message and a grant among them, only a person may.
 * A withdrawal counts only from whoever asked, so an agent's takes back only what it asked.
 */
export const AGENT_KINDS: ReadonlySet<string> = new Set(["job.progress", "job.result", "job.error", "job.cancelled", "job.request", "job.withdrawn"]);

/** The kinds that may be sent to everyone, "*". */
export const PUBLIC_KINDS: ReadonlySet<string> = new Set(["agent.register", "grant", "grant.revoke"]);

export type Content = z.infer<typeof contentSchema>;
export type Summary = (typeof SUMMARIES)[number];

/** What an event of kind K holds, as its author writes it: a field with a default, such as job.accepted's `delegate`, may be left out. */
export type ContentOf<K extends Content["kind"]> = Extract<z.input<typeof contentSchema>, { readonly kind: K }>["content"];

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** What an event says, by its kind; `unknown` for a kind this version does not know or content that is not what its kind holds. */
export function readContent(event: Event): Content | { readonly kind: "unknown" } {
  let content: unknown;
  try {
    content = parseJson(event.content);
  } catch {
    return { kind: "unknown" };
  }
  const read = contentSchema.safeParse({ kind: event.kind, content, ts: event.ts });
  return read.success ? read.data : { kind: "unknown" };
}
