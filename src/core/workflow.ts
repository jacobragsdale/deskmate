/** A workflow file: reading its YAML into a definition, and filling in its templates and conditions. Text in, values out: the hub, the command and the window all use it. No IO. */

import { CronPattern } from "croner";
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import type { Document } from "yaml";
import { z } from "zod";

import { problemOf } from "./text.ts";
import { NAME, nameSchema, REPO_NAME } from "./wire.ts";

const MAX_STEPS = 20;
const DAY = 86_400; // How long an approval waits when the step does not say, in seconds.

const text = z.string().min(1);
const pair = z.tuple([z.string(), z.string()]); // Two templates, filled before they are compared.

/** Whether a value is an object or a list, whose fields a template may name. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/**
 * A trigger, a step or a condition is written as an object with one of several keys, such as `post:` or `tag:`. This reads it by the schema for that key, through `kind`, which is set to
 * the key it was written with; so a mistake inside it is reported against what was meant, where a plain union would report every option it failed. A `kind` written in the file is refused.
 */
function byKey<T extends z.ZodType>(what: string, keys: readonly string[], schema: T): z.ZodPreprocess<T> {
  return z.preprocess((value, ctx) => {
    if (!isRecord(value) || Array.isArray(value)) {
      return value; // The schema says it is not an object.
    }
    const written = keys.filter((key) => Object.hasOwn(value, key));
    if (Object.hasOwn(value, "kind")) {
      ctx.addIssue({ code: "custom", message: 'Unrecognized key: "kind"' });
    } else if (written.length !== 1) {
      ctx.addIssue({ code: "custom", message: `${what} has exactly one of ${keys.join(", ")}` });
    }
    return { ...value, kind: written[0] };
  }, schema);
}

/** A cron line of five fields, as croner reads it; its words for what is wrong when it is not one. */
const cron = z.string().superRefine((line, ctx) => {
  try {
    new CronPattern(line, undefined, { mode: "5-part" }); // Parsing is all the constructor does; it throws on a line it cannot read.
  } catch (error) {
    ctx.addIssue({ code: "custom", message: problemOf(error).replace(/^CronPattern: /, "") });
  }
});

/** A time zone this runtime knows, by its IANA name, as croner will hand it to `Intl`. */
function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const triggerSchema = byKey(
  "a trigger",
  ["webhook", "message", "reaction", "schedule"],
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("webhook"), webhook: z.strictObject({ secret: text.optional() }) }), // An empty secret would match a request with no header.
    z.strictObject({ kind: z.literal("message"), message: z.strictObject({ contains: text }) }),
    z.strictObject({ kind: z.literal("reaction"), reaction: z.strictObject({ emoji: z.string().min(1).max(32) }) }), // As long as a reaction's emoji may be.
    z.strictObject({ kind: z.literal("schedule"), schedule: z.strictObject({ cron, zone: z.string().refine(isZone, "not a time zone, such as Europe/London or UTC") }) })
  ])
);

const conditionSchema = byKey(
  "a condition",
  ["equals", "contains"],
  z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("equals"), equals: pair }), z.strictObject({ kind: z.literal("contains"), contains: pair })])
);

const WITHIN = 'a number and m, h or d, such as "2h"';
/** How long an approval waits, written as "90m", "12h" or "2d", in seconds. */
const within = z
  .string(WITHIN)
  .regex(/^[1-9][0-9]{0,3}[mhd]$/, WITHIN)
  .transform((span) => Number(span.slice(0, -1)) * (span.endsWith("d") ? DAY : span.endsWith("h") ? 3_600 : 60));

// Every string a step holds is a template, but for the agent a `tag` names and the person an `approve` waits for: what a workflow can tag and who can let it go on is in the file.
const optionalIf = conditionSchema.optional();
const stepSchema = byKey(
  "a step",
  ["post", "tag", "approve", "webhook"],
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("post"), post: text, if: optionalIf }),
    z.strictObject({ kind: z.literal("tag"), tag: z.string().regex(new RegExp(`^@${NAME}/${REPO_NAME}$`), 'an agent, such as "@jacob/uploader"'), text, if: optionalIf }),
    z.strictObject({ kind: z.literal("approve"), approve: z.strictObject({ from: nameSchema, text, within: within.default(DAY) }), if: optionalIf }), // `from: anyone` is any member.
    z.strictObject({ kind: z.literal("webhook"), webhook: z.strictObject({ url: z.url({ protocol: /^https?$/, error: "an https or http address" }), body: z.string().optional() }), if: optionalIf })
  ])
);

/** A workflow file's contents. */
const workflowSchema = z
  .strictObject({
    name: nameSchema, // Grants name it as `workflow:<name>`, so it is a name like a person's.
    on: triggerSchema,
    steps: z
      .array(stepSchema)
      .min(1)
      .max(MAX_STEPS, `a workflow has at most ${String(MAX_STEPS)} steps`)
      .readonly()
  })
  .readonly();

export type Workflow = z.infer<typeof workflowSchema>;
export type Trigger = Workflow["on"];
export type Step = Workflow["steps"][number];
export type Condition = NonNullable<Step["if"]>;

/** What a template may name: `trigger.text` and `trigger.author`, and `body` for a webhook's JSON. */
export type Values = Readonly<Record<string, unknown>>;

/** The line, counting from 1, of the deepest part of `path` the file has: a mapping's key, or an item of a list. */
function lineOf(doc: Document.Parsed, lines: LineCounter, path: readonly PropertyKey[]): number {
  let node: unknown = doc.contents;
  let at = doc.contents?.range[0] ?? 0;
  for (const key of path) {
    if (isMap(node)) {
      const found = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(key));
      if (found === undefined || !isScalar(found.key)) {
        break;
      }
      at = found.key.range?.[0] ?? at;
      node = found.value;
    } else if (isSeq(node) && isNode(node.items[Number(key)])) {
      node = node.items[Number(key)];
      at = isNode(node) ? (node.range?.[0] ?? at) : at;
    } else {
      break; // An alias, or a part the file does not have, such as a key it left out.
    }
  }
  return lines.linePos(at).line;
}

/** Read a workflow file. Throws an error saying which line is wrong and why, such as `line 7: steps.2.text: required`. */
export function parseWorkflow(source: string): Workflow {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, prettyErrors: false });
  const broken = doc.errors[0];
  if (broken !== undefined) {
    throw new Error(`line ${String(lines.linePos(broken.pos[0]).line)}: ${broken.message}`);
  }
  let data: unknown;
  try {
    data = doc.toJS(); // Expands aliases, and refuses more than yaml's limit of them.
  } catch (error) {
    throw new Error(`line 1: ${problemOf(error)}`, { cause: error });
  }
  const read = workflowSchema.safeParse(data, { error: (issue) => (issue.code === "invalid_type" && issue.input === undefined ? "required" : undefined) });
  if (read.success) {
    return read.data;
  }
  const issue = read.error.issues[0];
  if (issue === undefined) {
    throw new Error("line 1: not a workflow");
  }
  const at = issue.code === "unrecognized_keys" ? [...issue.path, ...issue.keys.slice(0, 1)] : issue.path;
  throw new Error(`line ${String(lineOf(doc, lines, at))}: ${issue.path.length === 0 ? "" : `${issue.path.join(".")}: `}${issue.message}`);
}

/** A template with each `{{name}}` that names a string, number or true/false in `values` filled in, in one pass: what is filled in is not read again. An unknown name is left as written. */
export function fill(template: string, values: Values): string {
  return template.replace(/\{\{[^{}]*\}\}/g, (written) => {
    const value = written
      .slice(2, -2)
      .trim()
      .split(".")
      .reduce<unknown>((at, key) => (isRecord(at) && Object.hasOwn(at, key) ? at[key] : undefined), values);
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : written;
  });
}

/** Whether a step's condition holds: its two templates, filled in, are the same, or the first contains the second. */
export function holds(condition: Condition, values: Values): boolean {
  if (condition.kind === "equals") {
    return fill(condition.equals[0], values) === fill(condition.equals[1], values);
  }
  return fill(condition.contains[0], values).includes(fill(condition.contains[1], values));
}
