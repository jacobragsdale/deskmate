/** What an event of each kind this version knows says in its content, and reading it. The hub stores and relays every kind; a reader acts on the ones it knows and passes over the rest. No IO. */

import { z } from "zod";

import { branchSchema, NAME, permissionModeSchema, REPO_NAME, repoNameSchema, repoRefSchema } from "./wire.ts";
import type { Event } from "./wire.ts";

// Content travels as a string and the signature covers the string, so reading it with z.object, which passes over a field it does not know, changes nothing that was signed.
// It lets a later phase add a field to a kind without older readers losing the kind. A value this phase does not allow yet, such as a grant in `by`, still makes it unreadable.
const nothing = z.object({}).readonly();
const text = z.string().min(1);
const repo = repoNameSchema; // The repo of the agent a job is for. The agent's owner is the event's author.

/** What an agent at work is doing, in the only words job.progress may carry: never a path, a command or anything the agent wrote. */
export const SUMMARIES = ["thinking", "reading", "editing files", "running a command", "waiting for approval"] as const;

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
          by: z.literal("owner") // Phase 4 adds a grant.
        })
        .readonly()
    }),
    z.object({ kind: z.literal("job.declined"), content: z.object({ repo, reason: z.string() }).readonly() }),
    z.object({ kind: z.literal("job.progress"), content: z.object({ repo, summary: z.enum(SUMMARIES) }).readonly() }), // Coarse, for everyone in the chat.
    z.object({ kind: z.literal("job.result"), content: z.object({ repo, branch: branchSchema, text, reviewed: z.boolean() }).readonly() }),
    z.object({ kind: z.literal("job.error"), content: z.object({ repo }).readonly() }), // Only the fact: why stays with the owner.
    z.object({ kind: z.literal("job.cancelled"), content: z.object({ repo }).readonly() }),
    z.object({ kind: z.literal("job.withdrawn"), content: z.object({ agent: z.string().regex(new RegExp(`^${NAME}/${REPO_NAME}$`)) }).readonly() })
  ])
  .readonly();

export type Content = z.infer<typeof contentSchema>;
export type Summary = (typeof SUMMARIES)[number];

/** What an event of kind K holds. */
export type ContentOf<K extends Content["kind"]> = Extract<Content, { readonly kind: K }>["content"];

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
  const read = contentSchema.safeParse({ kind: event.kind, content });
  return read.success ? read.data : { kind: "unknown" };
}
