/** Wire format shared with the hub: the shape of a signed event, and of what the hub answers. */

import { z } from "zod";

export const PROTOCOL = 2; // Goes up when the hub and its clients must be updated together: 2 is events (0.5).
export const MAX_CONTENT = 64_000; // Most characters an event's content may hold, counted by code point.
export const MAX_PATCH = 512_000; // The same for a patch, which carries a diff.
const MAX_TEXT = MAX_CONTENT - 1_000; // Most of an event's content one text may take once written as JSON, leaving room for the rest of the content.
export const MAX_SKEW = 300; // Seconds a signed timestamp may differ from the verifier's clock.
// What the hub puts before and after each word a search found, in a result's snippet. The hub keeps both out of the text it indexes, so neither ever stands for something someone wrote.
export const HIT_OPEN = "\u0002";
export const HIT_CLOSE = "\u0003";
export const REPO_NAME = "[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?";
export const NAME = "[a-z0-9][a-z0-9_-]{0,31}";

/** A string of `min` to `max` characters, counted the way the hub counts them: by code point, not UTF-16 unit. */
function sized(min: number, max: number): z.ZodString {
  return z.string().refine((text) => {
    const length = Array.from(text).length;
    return length >= min && length <= max;
  });
}

/** Whether text holds at most `max` characters, counted as `sized` counts them. A text no longer than that in UTF-16 units is never counted. */
function within(text: string, max: number): boolean {
  return text.length <= max || Array.from(text).length <= max;
}

export const nameSchema = z.string().regex(new RegExp(`^${NAME}$`));
export const channelSchema = z.string().regex(new RegExp(`^#${NAME}$`));
export const addressSchema = z.string().regex(new RegExp(`^#?${NAME}$`)); // A person, or a channel when it starts with "#".
export const repoNameSchema = z.string().regex(new RegExp(`^${REPO_NAME}$`));
// eslint-disable-next-line no-control-regex -- the hub's pattern excludes control characters, and this one must accept exactly what it accepts
const repoKeySchema = sized(0, 300).regex(/^[a-z0-9.-]+(\/[^/\x00-\x20]+)+$/);
// eslint-disable-next-line no-control-regex -- as above
const repoUrlSchema = sized(0, 400).regex(/^https:\/\/[^\x00-\x20]+$/);
// eslint-disable-next-line no-control-regex -- as above
export const branchSchema = sized(1, 200).regex(/^[^\x00-\x1f]+$/);
const pubKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
const signatureSchema = z.string().regex(/^[0-9a-f]{128}$/);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/); // An event's id, or a link in the hub's chain: a sha256 in hex.

export const userSchema = z.strictObject({ name: nameSchema, pubkey: pubKeySchema }).readonly();

/** What someone sends to register a name: the name, their key, and the token the hub's owner gave the team. */
export const joinSchema = z.strictObject({ name: nameSchema, pubkey: pubKeySchema, token: z.string() }).readonly();

// What the hub answers with is read with z.object, which drops a key it does not know, so the hub can add a field without every older client refusing the answer.
// That is Person, HubInfo, TeamRepo, ChannelInfo, Delivered and Receipt. An event is the exception, also inside Delivered: every field of it is signed, so one nobody expected is a reason to refuse it.

/** Someone who has joined, and the Unix seconds of their last signed request; 0 if they have never made one. */
export const personSchema = z.object({ name: nameSchema, pubkey: pubKeySchema, seen: z.int() }).readonly();

/** What the hub says about itself. `repos` is the key every shareable repo starts with, such as "dev.azure.com/acme"; `now` is the hub's clock in Unix seconds. */
export const hubInfoSchema = z.object({ version: z.string(), protocol: z.int(), repos: z.string(), now: z.int() }).readonly();

/** A repo as everyone can refer to it. */
export const repoRefSchema = z.strictObject({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema }).readonly();

/** A repo someone has checked out, and the branch their copy is on. */
export const repoSchema = z.strictObject({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema, branch: branchSchema }).readonly();

export const teamRepoSchema = z.object({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema, branch: branchSchema, user: nameSchema }).readonly();

/** A repo as the hub reports it: read with z.object like the rest of an answer, so a field a later hub adds to it (phase 6 adds to a pin) is passed over. */
const reportedRepoSchema = z.object({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema }).readonly();

/** `repo` is the repo the channel is about, if one is pinned, and `branch` the branch the pin names, if it names one. */
export const channelInfoSchema = z.object({ name: channelSchema, members: z.array(nameSchema).readonly(), repo: reportedRepoSchema.nullable(), branch: branchSchema.nullable() }).readonly();

/** Anything that happens, signed by whoever did it. The hub stores and relays it unchanged, whatever its kind, so every reader can check it too. */
export const eventSchema = z
  .strictObject({
    id: hashSchema, // The sha256 of the signed bytes, so the author knows it before sending.
    author: nameSchema,
    to: z.string().regex(new RegExp(`^(#?${NAME}|\\*)$`)), // A person, a channel, or "*" for everyone.
    kind: z
      .string()
      .max(64)
      .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/), // Dotted lowercase words, such as "job.accepted".
    content: z.string(), // JSON text of an object whose shape depends on the kind (see kinds.ts). A string, so nobody has to agree on one way of writing an object.
    ts: z.int(), // Unix seconds, UTC.
    refs: z.array(hashSchema).max(8).readonly(), // The ids of the events this one is about, the main one first.
    nonce: z.string().regex(/^[0-9a-f]{16}$/), // Random, so the same message twice in one second is two events.
    sig: signatureSchema
  })
  .refine((event) => within(event.content, event.kind === "patch" ? MAX_PATCH : MAX_CONTENT), { message: "too long for its kind", path: ["content"] })
  .readonly();

/** An event as the hub hands it over, with the place it was given in the hub's log. */
export const deliveredSchema = z.object({ seq: z.int(), event: eventSchema }).readonly();

/** What the hub answers when it has stored an event: the place it gave it. */
export const receiptSchema = z.object({ seq: z.int() }).readonly();

/** What an agent may do without asking, from least to most: the table is "Permission modes" in docs/plan/protocol.md, and src/desk/permissions.ts holds it. */
export const MODES = ["read-only", "supervised", "auto-edits", "full"] as const;
export const permissionModeSchema = z.enum(MODES);

/** One agent the user can run: a program and its arguments, which no shell ever reads, spoken to over ACP or run once with the prompt added as its last argument. */
export const agentSchema = z
  .strictObject({ id: nameSchema, label: z.string().min(1), protocol: z.enum(["acp", "oneshot"]), command: z.string().min(1), args: z.array(z.string()).readonly() })
  .readonly();

/** config.json: who this is on which hub, the agents they can run, which of them answers, and the mode their own requests of their own agents run at. */
export const configSchema = z
  .strictObject({ hub: z.string().regex(/^https?:\/\/\S*[^/\s]$/), name: nameSchema, agents: z.array(agentSchema).min(1).readonly(), defaultAgent: nameSchema, ownMode: permissionModeSchema })
  .refine((config) => new Set(config.agents.map((agent) => agent.id)).size === config.agents.length, { message: "two agents have the same id", path: ["agents"] })
  .refine((config) => config.agents.some((agent) => agent.id === config.defaultAgent), { message: "the default agent is not one of the agents", path: ["defaultAgent"] })
  .readonly();

export type Person = z.infer<typeof personSchema>;
export type HubInfo = z.infer<typeof hubInfoSchema>;
export type RepoRef = z.infer<typeof repoRefSchema>;
export type Repo = z.infer<typeof repoSchema>;
export type TeamRepo = z.infer<typeof teamRepoSchema>;
export type ChannelInfo = z.infer<typeof channelInfoSchema>;
export type Event = z.infer<typeof eventSchema>;
export type Delivered = z.infer<typeof deliveredSchema>;
export type Config = z.infer<typeof configSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export function isChannel(address: string): boolean {
  return address.startsWith("#");
}

/** The agent that answers. A config that has been parsed always has it. */
export function defaultAgentOf(config: Config): Agent {
  const agent = config.agents.find((each) => each.id === config.defaultAgent);
  if (agent === undefined) {
    throw new Error(`config.json names ${config.defaultAgent} as the default agent, and has no agent of that id`);
  }
  return agent;
}

/** Cut text so that, written as JSON in an event's content, it leaves room for the rest of the content, without leaving half a character at the end. Escaping can make text several times longer, so it is measured as written. */
export function fitText(text: string): string {
  let fitted = text.toWellFormed();
  for (let room = MAX_TEXT; JSON.stringify(fitted).length > MAX_TEXT; room = Math.floor(room * 0.9)) {
    fitted = Array.from(fitted).slice(0, room).join("");
  }
  return fitted;
}
