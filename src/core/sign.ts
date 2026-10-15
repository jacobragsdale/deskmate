/** Ed25519 keys and what is signed with them: events, and the header that proves who is asking. */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { AUTHOR, eventSchema, MAX_SKEW } from "./wire.ts";
import type { Event } from "./wire.ts";

const AUTH_SCHEME = "PlayerTwo";
// A raw 32-byte Ed25519 key is these fixed DER headers followed by the key itself.
const PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");
const KEY_BYTES = 32;

export function newKey(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}

export function loadKey(privateHex: string): KeyObject {
  if (!/^[0-9a-fA-F]{64}$/.test(privateHex)) {
    throw new Error("the key file does not hold a 32-byte key in hex");
  }
  return createPrivateKey({ key: Buffer.concat([PKCS8_HEADER, Buffer.from(privateHex, "hex")]), format: "der", type: "pkcs8" });
}

export function privateHex(key: KeyObject): string {
  return key.export({ format: "der", type: "pkcs8" }).subarray(-KEY_BYTES).toString("hex");
}

export function publicHex(key: KeyObject): string {
  return createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-KEY_BYTES).toString("hex");
}

export function verifySignature(pubkey: string, payload: Buffer, sig: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(pubkey) || !/^[0-9a-f]{128}$/.test(sig)) {
    return false;
  }
  try {
    return verify(null, payload, createPublicKey({ key: Buffer.concat([SPKI_HEADER, Buffer.from(pubkey, "hex")]), format: "der", type: "spki" }), Buffer.from(sig, "hex"));
  } catch {
    return false; // A key that is not a point on the curve.
  }
}

export function isFresh(ts: number, now: number): boolean {
  return Math.abs(now - ts) <= MAX_SKEW;
}

/** What the author of an event says: everything in it but the id and the signature, which are worked out from these. */
interface EventFields {
  readonly author: string;
  readonly to: string;
  readonly kind: string;
  readonly content: string;
  readonly ts: number;
  readonly refs: readonly string[];
}

/**
 * The bytes an event's id is the hash of and its signature signs: a JSON array of fixed positions, which has exactly one encoding, so both sides sign the same bytes.
 * JSON.stringify writes it with no spaces and leaves every character outside ASCII as it is; test/vectors.test.ts holds the bytes to the record.
 */
export function eventBytes(fields: EventFields & { readonly nonce: string }): Buffer {
  return Buffer.from(JSON.stringify(["player-two-event-v1", fields.author, fields.to, fields.kind, fields.content, fields.ts, fields.refs, fields.nonce]), "utf8");
}

/** The id an event with these fields has: the sha256 of its signed bytes, in hex. */
export function eventId(fields: EventFields & { readonly nonce: string }): string {
  return createHash("sha256").update(eventBytes(fields)).digest("hex");
}

/** Sign an event. Its id is known from here on, before the hub has seen it. `nonce` is random unless a test or the vectors fix it. */
export function signEvent(key: KeyObject, fields: EventFields, nonce: string = randomBytes(8).toString("hex")): Event {
  const signed = { author: fields.author, to: fields.to, kind: fields.kind, content: fields.content, ts: fields.ts, refs: fields.refs, nonce }; // Field by field, so an event passed in as its own fields brings no old id or signature along.
  return eventSchema.parse({ id: eventId(signed), ...signed, sig: sign(null, eventBytes(signed), key).toString("hex") });
}

/** Whether an event is what `pubkey`'s owner signed: its id is the hash of its fields, and its signature holds. */
export function eventIsAuthentic(event: Event, pubkey: string): boolean {
  return event.id === eventId(event) && verifySignature(pubkey, eventBytes(event), event.sig);
}

/** What an auth header signs: who is asking, when, and for what. `path` is the path and query exactly as sent, so a header taken off one request is no use on another. */
function authPayload(name: string, ts: number, method: string, path: string): Buffer {
  return Buffer.from(`player-two-auth-v2:${name}:${String(ts)}:${method}:${path}`, "utf8");
}

/** Prove who is asking for this one request. It gates reads and who may post: every event carries its own signature as well. */
export function authHeader(key: KeyObject, name: string, ts: number, method: string, path: string): string {
  return `${AUTH_SCHEME} ${name}:${String(ts)}:${sign(null, authPayload(name, ts, method, path), key).toString("hex")}`;
}

/** Who an auth header says it is from, and when and how it was signed. */
export interface AuthClaim {
  readonly name: string;
  readonly ts: number;
  readonly sig: string;
}

/** Split an auth header into its claim without trusting it yet: `name` is a person, or from phase 4 one of their agents, "owner/repo". Null when it is not one. */
export function authClaim(header: string): AuthClaim | null {
  const space = header.indexOf(" ");
  const [name = "", ts = "", sig = ""] = (space === -1 ? "" : header.slice(space + 1)).split(":");
  if (space === -1 || header.slice(0, space) !== AUTH_SCHEME || !new RegExp(`^${AUTHOR}$`).test(name) || !/^\d{1,12}$/.test(ts)) {
    return null;
  }
  return { name, ts: Number(ts), sig };
}

/** Whether a claim was signed by `pubkey`, lately, for the request that carried it: `method` and `path` are what the hub actually received. */
export function authIsValid(claim: AuthClaim, pubkey: string, now: number, method: string, path: string): boolean {
  return isFresh(claim.ts, now) && verifySignature(pubkey, authPayload(claim.name, claim.ts, method, path), claim.sig);
}
