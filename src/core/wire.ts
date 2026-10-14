/** Wire format shared with the hub: the shapes of signed notes and of what the hub answers. Mirrors src/deskmate/wire.py. */

import { z } from "zod";

export const PROTOCOL = 1; // Goes up when the hub and its clients must be updated together.
export const MAX_BODY = 64_000;
export const MAX_SKEW = 300; // Seconds a signed timestamp may differ from the verifier's clock.
export const REPO_NAME = "[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?";
export const NAME = "[a-z0-9][a-z0-9_-]{0,31}";

/** A string of `min` to `max` characters, counted the way the hub counts them: by code point, not UTF-16 unit. */
function sized(min: number, max: number): z.ZodString {
  return z.string().refine((text) => {
    const length = Array.from(text).length;
    return length >= min && length <= max;
  });
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
const branchSchema = sized(1, 200).regex(/^[^\x00-\x1f]+$/);
const pubKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
const signatureSchema = z.string().regex(/^[0-9a-f]{128}$/);
export const kindSchema = z.enum(["note", "status"]); // A status reports what an agent is doing with a note; it is never shown as a message.

export const userSchema = z.strictObject({ name: nameSchema, pubkey: pubKeySchema }).readonly();

/** What someone sends to register a name: the name, their key, and the token the hub's owner gave the team. */
export const joinSchema = z.strictObject({ name: nameSchema, pubkey: pubKeySchema, token: z.string() }).readonly();

/** Someone who has joined, and the Unix seconds of their last signed request; 0 if they have never made one. */
export const personSchema = z.strictObject({ name: nameSchema, pubkey: pubKeySchema, seen: z.int() }).readonly();

/** What the hub says about itself. `repos` is the key every shareable repo starts with, such as "dev.azure.com/acme"; `now` is the hub's clock in Unix seconds. */
export const hubInfoSchema = z.strictObject({ version: z.string(), protocol: z.int(), repos: z.string(), now: z.int() }).readonly();

/** A repo as everyone can refer to it. */
export const repoRefSchema = z.strictObject({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema }).readonly();

/** A repo someone has checked out, and the branch their copy is on. */
export const repoSchema = z.strictObject({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema, branch: branchSchema }).readonly();

export const teamRepoSchema = z.strictObject({ name: repoNameSchema, key: repoKeySchema, url: repoUrlSchema, branch: branchSchema, user: nameSchema }).readonly();

/** `repo` is the repo the channel is about, if one is pinned. */
export const channelInfoSchema = z.strictObject({ name: channelSchema, members: z.array(nameSchema).readonly(), repo: repoRefSchema.nullable() }).readonly();

/** A message signed by its sender. The hub relays it unchanged, so every recipient can verify it too. */
export const noteSchema = z
  .strictObject({
    sender: nameSchema,
    to: addressSchema,
    kind: kindSchema,
    body: sized(1, MAX_BODY),
    ts: z.int(), // Unix seconds, UTC.
    agent: repoNameSchema.nullable(), // The repo the sender's agent worked in; null when the sender typed the note.
    re: z.int().nullable(), // The id of the note this one answers; null when it answers nothing.
    sig: signatureSchema
  })
  .readonly();

export const deliveredSchema = z.strictObject({ id: z.int(), note: noteSchema }).readonly();
export const receiptSchema = z.strictObject({ id: z.int() }).readonly();

export const configSchema = z.strictObject({ hub: z.string().regex(/^https?:\/\/\S*[^/\s]$/), name: nameSchema, agent: z.string().min(1) }).readonly();

export type Kind = z.infer<typeof kindSchema>;
export type Person = z.infer<typeof personSchema>;
export type HubInfo = z.infer<typeof hubInfoSchema>;
export type RepoRef = z.infer<typeof repoRefSchema>;
export type Repo = z.infer<typeof repoSchema>;
export type TeamRepo = z.infer<typeof teamRepoSchema>;
export type ChannelInfo = z.infer<typeof channelInfoSchema>;
export type Note = z.infer<typeof noteSchema>;
export type Delivered = z.infer<typeof deliveredSchema>;
export type Config = z.infer<typeof configSchema>;

export function isChannel(address: string): boolean {
  return address.startsWith("#");
}

/** Cut text to what one note may hold, without leaving half a character at the end. */
export function fitBody(text: string): string {
  const whole = text.toWellFormed();
  return whole.length <= MAX_BODY ? whole : Array.from(whole).slice(0, MAX_BODY).join("");
}
