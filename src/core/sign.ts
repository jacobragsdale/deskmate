/** Ed25519 keys and the two things signed with them: notes, and the header that proves who is asking. Mirrors the signing half of src/deskmate/wire.py. */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { MAX_SKEW, noteSchema } from "./wire.ts";
import type { Kind, Note } from "./wire.ts";

const AUTH_SCHEME = "Deskmate";
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

interface NoteFields {
  readonly sender: string;
  readonly to: string;
  readonly kind: Kind;
  readonly body: string;
  readonly ts: number;
  readonly agent: string | null;
  readonly re: number | null;
}

function notePayload(note: NoteFields): Buffer {
  // A JSON array of fixed positions has exactly one encoding, so both sides sign the same bytes.
  // JSON.stringify writes it as Python's json.dumps(ensure_ascii=False, separators=(",", ":")) does; test/vectors.test.ts holds that to account.
  return Buffer.from(JSON.stringify(["deskmate-note-v3", note.sender, note.to, note.kind, note.body, note.ts, note.agent, note.re]), "utf8");
}

export function signNote(key: KeyObject, fields: NoteFields): Note {
  return noteSchema.parse({ ...fields, sig: sign(null, notePayload(fields), key).toString("hex") });
}

export function noteIsAuthentic(note: Note, pubkey: string): boolean {
  return verifySignature(pubkey, notePayload(note), note.sig);
}

function authPayload(name: string, ts: number): Buffer {
  return Buffer.from(`deskmate-auth-v1:${name}:${String(ts)}`, "utf8");
}

/** Prove who is asking. It gates reads and channel membership: every note carries its own signature. */
export function authHeader(key: KeyObject, name: string, ts: number): string {
  return `${AUTH_SCHEME} ${name}:${String(ts)}:${sign(null, authPayload(name, ts), key).toString("hex")}`;
}

/** Who an auth header says it is from, and when and how it was signed. */
export interface AuthClaim {
  readonly name: string;
  readonly ts: number;
  readonly sig: string;
}

/** Split an auth header into its claim without trusting it yet. Null when it is not one. */
export function authClaim(header: string): AuthClaim | null {
  const space = header.indexOf(" ");
  const [name = "", ts = "", sig = ""] = (space === -1 ? "" : header.slice(space + 1)).split(":");
  if (space === -1 || header.slice(0, space) !== AUTH_SCHEME || !/^\d{1,12}$/.test(ts)) {
    return null;
  }
  return { name, ts: Number(ts), sig };
}

export function authIsValid(claim: AuthClaim, pubkey: string, now: number): boolean {
  return isFresh(claim.ts, now) && verifySignature(pubkey, authPayload(claim.name, claim.ts), claim.sig);
}
