/** Wire format shared with the hub: the shape of a signed event, and of what the hub answers. */

import { z } from "zod";

export const PROTOCOL = 3; // Goes up when the hub and its clients must be updated together: 2 is events (0.5); 3 lets an agent author an event (phase 4), which a client before it cannot read.
export const MAX_CONTENT = 64_000; // Most characters an event's content may hold, counted by code point.
export const MAX_PATCH = 512_000; // The same for a patch, which carries a diff.
const MAX_TEXT = MAX_CONTENT - 1_000; // Most of an event's content one text may take once written as JSON, leaving room for the rest of the content.
export const MAX_SKEW = 300; // Seconds a signed timestamp may differ from the verifier's clock.
// What the hub puts before and after each word a search found, in a result's snippet. The hub keeps both out of the text it indexes, so neither ever stands for something someone wrote.
export const HIT_OPEN = "\u0002";
export const HIT_CLOSE = "\u0003";
export const REPO_NAME = "[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?";
export const NAME = "[a-z0-9][a-z0-9_-]{0,31}";
export const AUTHOR = `${NAME}(?:/${REPO_NAME})?`; // Who signs: a person, or one of their agents, "owner/repo".
export const HUB = "hub"; // The hub's own name from phase 7, which nobody may join under: it signs what a workflow posts with a key of its own.

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
export const authorSchema = z.string().regex(new RegExp(`^${AUTHOR}$`)); // A person, or one of their agents.
export const channelSchema = z.string().regex(new RegExp(`^#${NAME}$`));
export const addressSchema = z.string().regex(new RegExp(`^#?${NAME}$`)); // A person, or a channel when it starts with "#".
export const repoNameSchema = z.string().regex(new RegExp(`^${REPO_NAME}$`));
// eslint-disable-next-line no-control-regex -- the hub's pattern excludes control characters, and this one must accept exactly what it accepts
const repoKeySchema = sized(0, 300).regex(/^[a-z0-9.-]+(\/[^/\x00-\x20]+)+$/);
// eslint-disable-next-line no-control-regex -- as above
const repoUrlSchema = sized(0, 400).regex(/^https:\/\/[^\x00-\x20]+$/);
// eslint-disable-next-line no-control-regex -- as above
export const branchSchema = sized(1, 200).regex(/^[^\x00-\x1f]+$/); // Where a checkout is, as its desk reads it: a detached head is "detached at a1b2c3d".
/**
 * A branch's name as `git check-ref-format --branch` takes one, for what is handed to git and Azure DevOps as it stands, as a pin's branch is: no part starting with "." or ending in ".lock",
 * no "..", "@{" or "//", not starting with "-" or "/" nor ending in "/" or ".", no space, ~ ^ : ? * [ \ or ASCII control, and not "HEAD". Stricter than git in two ways: not "@",
 * which git's commands read as HEAD; and no other control, formatting character or line separator, such as a bidi override, which git takes and which would turn the name around
 * where it is drawn.
 */
export const branchNameSchema = sized(1, 200).refine(
  (name) => name !== "HEAD" && name !== "@" && !/^[-/]|[/.]$|\.\.|@\{|\/\/|(?:^|\/)\.|\.lock(?:\/|$)|[ ~^:?*[\\\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)
);
export const pubKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
const signatureSchema = z.string().regex(/^[0-9a-f]{128}$/);
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/); // An event's id, or a link in the hub's chain: a sha256 in hex.

export const userSchema = z.strictObject({ name: nameSchema, pubkey: pubKeySchema }).readonly();

/** What someone sends to register a name: the name, their key, and the token the hub's owner gave the team. */
export const joinSchema = z.strictObject({ name: nameSchema, pubkey: pubKeySchema, token: z.string() }).readonly();

// What the hub answers with is read with z.object, which drops a key it does not know, so the hub can add a field without every older client refusing the answer.
// That is Person, HubInfo, TeamRepo, ChannelInfo, Delivered and Receipt. An event is the exception, also inside Delivered: every field of it is signed, so one nobody expected is a reason to refuse it.

/** Someone who has joined, and the Unix seconds of their last signed request; 0 if they have never made one. */
export const personSchema = z.object({ name: nameSchema, pubkey: pubKeySchema, seen: z.int() }).readonly();

/**
 * What the hub says about itself. `repos` is the key every shareable repo starts with, such as "dev.azure.com/acme"; `now` is the hub's clock in Unix seconds;
 * `hubKey`, from phase 7, the key the hub signs its own events with, which a hub before it does not send.
 */
export const hubInfoSchema = z.object({ version: z.string(), protocol: z.int(), repos: z.string(), now: z.int(), hubKey: pubKeySchema.optional() }).readonly();

/**
 * A repo as everyone can refer to it. Its name is the last part of its key, as every client makes both from a remote (src/core/remotes.ts), so that one cannot be named while the other
 * is meant: a desk finds a checkout by its key, and an agent is held to its own repo by name.
 */
export const repoRefSchema = z
  .strictObject({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema })
  .refine((ref) => ref.key.split("/").at(-1) === ref.name, { message: "a repo's name is the last part of its key" })
  .readonly();

/** A repo someone has checked out, and the branch their copy is on. */
export const repoSchema = z.strictObject({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema, branch: branchSchema }).readonly();

export const teamRepoSchema = z.object({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema, branch: branchSchema, user: nameSchema }).readonly();

/** A repo as the hub reports it: read with z.object like the rest of an answer, so a field a later hub adds to it (phase 6 adds to a pin) is passed over. */
const reportedRepoSchema = z.object({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema }).readonly();

/**
 * `repo` is the repo the channel is about, if one is pinned, and `branch` the branch the pin names, if it names one. A branch git would not take as one, which a hub should have refused,
 * is read as none, so that one such pin hides no channel and names nothing git or Azure DevOps is given.
 */
export const channelInfoSchema = z
  .object({ name: channelSchema, members: z.array(nameSchema).readonly(), repo: reportedRepoSchema.nullable(), branch: branchNameSchema.nullable().catch(null) })
  .readonly();

/** Anything that happens, signed by whoever did it. The hub stores and relays it unchanged, whatever its kind, so every reader can check it too. */
export const eventSchema = z
  .strictObject({
    id: hashSchema, // The sha256 of the signed bytes, so the author knows it before sending.
    author: authorSchema, // A person, or one of their agents, which signs with a key of its own.
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

/**
 * config.json: who this is on which hub, the agents they can run, which of them answers, the mode their own requests of their own agents run at, and the repos they hold back:
 * not shared with the team, and their agents answering nobody. A config from before there was anything to hold back has no `held`.
 */
export const configSchema = z
  .strictObject({
    hub: z.string().regex(/^https?:\/\/\S*[^/\s]$/),
    name: nameSchema,
    agents: z.array(agentSchema).min(1).readonly(),
    defaultAgent: nameSchema,
    ownMode: permissionModeSchema,
    held: z.array(repoNameSchema).readonly().optional()
  })
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

/** Whether an author is an agent, "owner/repo", rather than a person. */
export function isAgent(author: string): boolean {
  return author.includes("/");
}

/** The person an author is, or the owner of the agent it is. */
export function ownerOf(author: string): string {
  const slash = author.indexOf("/");
  return slash === -1 ? author : author.slice(0, slash);
}

/** An agent's program and arguments as one line to read, each word that a shell would split or change in single quotes. Nothing runs it: an agent is started from the words themselves. */
export function commandLineOf(agent: Pick<Agent, "command" | "args">): string {
  return [agent.command, ...agent.args].map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)).join(" ");
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
