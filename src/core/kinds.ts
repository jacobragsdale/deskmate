/** What an event of each kind this version knows says in its content, and reading it. The hub stores and relays every kind; a reader acts on the ones it knows and passes over the rest. No IO. */

import { z } from "zod";

import { askerSchema, branchNameSchema, branchSchema, hashSchema, NAME, nameSchema, permissionModeSchema, pubKeySchema, REPO_NAME, repoNameSchema, repoRefSchema } from "./wire.ts";
import type { Event } from "./wire.ts";

// Content travels as a string and the signature covers the string, so reading it with z.object, which passes over a field it does not know, changes nothing that was signed.
// It lets a later phase add a field to a kind without older readers losing the kind. A value this version does not allow, such as a mode it has never heard of, still makes it unreadable.
const nothing = z.object({}).readonly();
const text = z.string().min(1);
const repo = repoNameSchema; // The repo of the agent a job is for. The agent's owner is the event's author.
const agent = z.string().regex(new RegExp(`^${NAME}/${REPO_NAME}$`)); // "owner/repo": one person's checkout's agent.
const commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/); // SHA-1, or SHA-256 for a repository that uses it.

/** What an agent at work is doing, in the only words job.progress may carry: never a path, a command or anything the agent wrote. */
export const SUMMARIES = ["thinking", "reading", "editing files", "running a command", "waiting for approval"] as const;

export const MAX_GRANT = 30 * 86_400; // Most seconds a grant may last after its event's time.

/**
 * How a step of a workflow's run came out: done, passed over as its `if` did not hold, waiting on an approval, approved, past its approval's time, a webhook refused or failed, the whole run
 * throttled by a limit before it started, or called off as its workflow was replaced or removed.
 */
export const RUN_STATUSES = ["done", "skipped", "waiting", "approved", "expired", "refused", "failed", "throttled", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The content of each kind this version knows, tagged with the kind. */
export const contentSchema = z
  .discriminatedUnion("kind", [
    // A reply has its thread's root as refs[0]. `workflow`, from phase 7, names the workflow a message of the hub's was posted for, which its tags then ask as.
    z.object({ kind: z.literal("message"), content: z.object({ text, via: z.enum(["window", "cli", "mcp", "workflow"]), workflow: nameSchema.optional() }).readonly() }),
    z.object({ kind: z.literal("message.edit"), content: z.object({ text }).readonly() }),
    z.object({ kind: z.literal("message.delete"), content: nothing }),
    z.object({ kind: z.literal("reaction"), content: z.object({ emoji: z.string().min(1).max(32), on: z.boolean() }).readonly() }), // `on: false` takes it back.
    z.object({ kind: z.literal("channel.join"), content: nothing }),
    z.object({ kind: z.literal("channel.leave"), content: nothing }),
    // `repo: null` unpins. `branch` makes the channel a room about that branch, from phase 6; null is about the whole repo, and unpinning. A reader before phase 6 cannot read one with a branch.
    // It is a name git takes for a branch, as section C hands it to git and Azure DevOps.
    z.object({
      kind: z.literal("channel.pin"),
      content: z
        .object({ repo: repoRefSchema.nullable(), branch: branchNameSchema.nullable() })
        .refine((pin) => pin.repo !== null || pin.branch === null, "a branch goes with a repo")
        .readonly()
    }),
    z.object({
      kind: z.literal("job.accepted"),
      content: z
        .object({
          repo,
          branch: branchSchema,
          commit,
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
            askers: z.array(askerSchema).readonly(), // Names, "*" for anyone on the hub, or from phase 7 "workflow:#ops/ci-failure", a workflow in one channel, which "*" does not cover.
            mode: permissionModeSchema,
            delivery: z.enum(["review", "post"]),
            expires: z.int(), // Unix seconds.
            runsPerDay: z.int().min(1).max(1000)
          })
          .readonly(),
        ts: z.int()
      })
      .refine(({ content, ts }) => content.expires <= ts + MAX_GRANT, { message: "a grant lasts at most 30 days", path: ["content", "expires"] }),
    z.object({ kind: z.literal("grant.revoke"), content: nothing }), // refs[0] is the grant. Counts only from the grant's author.
    // From phase 6, what a run on a clean copy changed, as a diff from `base` that git apply takes, made on `branch` of `repo`: refs[0] is the request, and it is signed as its answer is,
    // by the agent when nobody reviewed it and by its owner when they did. Every word of it is someone else's, to be drawn as text and applied only once its paths have been checked.
    z.object({ kind: z.literal("patch"), content: z.object({ repo: repoRefSchema, base: commit, branch: branchSchema, title: z.string().min(1).max(200), diff: text }).readonly() }),
    z.object({ kind: z.literal("patch.applied"), content: z.object({ branch: branchSchema }).readonly() }), // refs[0] is the patch, which its author applied to their checkout on `branch`.
    z.object({ kind: z.literal("review"), content: z.object({ verdict: z.enum(["approve", "changes"]), text: z.string() }).readonly() }), // refs[0] is the patch: its author's verdict, and a comment, "" for none.
    // A workflow, from phase 7: a member of the channel in `to` publishes its file, which src/core/workflow.ts reads and whose own `name` must be this one, and the hub makes it live there,
    // in place of any of that name; or takes the one of that name away. Both are structural.
    z.object({ kind: z.literal("workflow.define"), content: z.object({ name: nameSchema, yaml: text }).readonly() }),
    z.object({ kind: z.literal("workflow.remove"), content: z.object({ name: nameSchema }).readonly() }),
    // What run number `run` of a workflow did at one step, the first being 0, and why in `detail`, "" when there is nothing to add. refs[0] is the workflow.define it runs, and refs[1] the message
    // the step posted, or for an approval's outcome the message it waited on. Counts only from the hub, which runs them.
    z.object({ kind: z.literal("workflow.run"), content: z.object({ workflow: nameSchema, run: z.int().min(1), step: z.int().min(0), status: z.enum(RUN_STATUSES), detail: z.string() }).readonly() })
  ])
  .readonly();

/**
 * The kinds an agent may author: its run's own reports, from phase 5 a request of another agent and taking one back, and from phase 6 the patch its run hands over. Everything else, a message and a grant among them, only a person may.
 * A withdrawal counts only from whoever asked, so an agent's takes back only what it asked.
 */
export const AGENT_KINDS: ReadonlySet<string> = new Set(["job.progress", "job.result", "job.error", "job.cancelled", "job.request", "job.withdrawn", "patch"]);

/** The kinds that may be sent to everyone, "*". */
export const PUBLIC_KINDS: ReadonlySet<string> = new Set(["agent.register", "grant", "grant.revoke"]);

export type Content = z.infer<typeof contentSchema>;
export type Summary = (typeof SUMMARIES)[number];

/** The repo a job's event or a patch is about, by name: an agent sends either only about its own. Null for any other kind. */
export function repoOf(said: Content): string | null {
  if (said.kind === "patch") {
    return said.content.repo.name;
  }
  return "repo" in said.content && typeof said.content.repo === "string" ? said.content.repo : null;
}

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
