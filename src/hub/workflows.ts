/**
 * The hub running each channel's workflows. A run is a row in workflow_runs; its steps are taken one at a time, and after each the hub signs a workflow.run saying how it came out,
 * stored with whatever the step posted and the row's new place in one transaction. The hub never runs an agent: what it posts is a message like anyone's.
 */

import type { KeyObject } from "node:crypto";
import { lookup } from "node:dns";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import type { LookupFunction } from "node:net";

import { Cron } from "croner";

import { mentions, spans } from "../core/chat.ts";
import { readContent } from "../core/kinds.ts";
import type { Content, ContentOf, RunStatus } from "../core/kinds.ts";
import { signEvent } from "../core/sign.ts";
import { problemOf } from "../core/text.ts";
import { fill, holds, parseWorkflow } from "../core/workflow.ts";
import type { Step, Trigger, Values, Workflow } from "../core/workflow.ts";
import { fitText, HUB, isAgent, isChannel } from "../core/wire.ts";
import type { Event } from "../core/wire.ts";
import type { Log } from "./app.ts";
import type { Database, Live, Run, RunState } from "./db.ts";

/** What the hub does with workflows, once it has opened its database. */
export interface Workflows {
  /** Act on an event the hub has just stored, whoever signed it: a trigger it matches sets a run off. Never throws, as the event is kept whatever a run does. */
  readonly seen: (event: Event) => void;
  /** The live workflow a webhook's id, the first 32 hex of its definition's id, names: the secret it asks for, and setting a run off with a request's body. Null for none. */
  readonly hook: (id: string) => { readonly secret: string | null; readonly start: (body: unknown) => void } | null;
  /** Stop for good, as the hub closes: no schedule fires after, no wait is checked, and a webhook being called is hung up on. */
  readonly stop: () => void;
  /** How many files are kept parsed, which is how many workflows are live: for a test to count. */
  readonly parsed: () => number;
}

/** Which run a step is of: its number, and the channel, name and definition of the workflow it runs, as its row has them. */
type Ref = Pick<Run, "run" | "channel" | "name" | "definition">;

/** A run under way: which it is, the file it runs, and the values its templates are filled from. */
interface Going extends Ref {
  readonly file: Workflow;
  readonly values: Values;
}

/** Where a run is once a step has been recorded: the step it is at, its state, and for one now waiting on an approval, for how many seconds. */
interface Place {
  readonly step: number;
  readonly state: RunState;
  readonly within?: number;
}

const SWEEP = 60; // Seconds between looks for approvals whose time has passed. ponytail: one may end up to a minute late; a timer per wait if that ever matters.
const THUMBS_UP = /^👍[\u{1F3FB}-\u{1F3FF}]?$/u; // In any skin tone.
const CALL_TIME = 10; // Seconds a webhook step's call may take, answer and all.
const MAX_ANSWER = 1024 * 1024; // Most bytes of a webhook's answer the hub reads, and throws away: nothing of it goes into the chat.
const ALLOW = "PLAYER_TWO_WEBHOOK_ALLOW";
const HOURLY = 30; // Most runs one workflow may start in an hour.
const WAITING = 50; // Most runs of one workflow that may wait for a 👍 at once.
const MAX_DETAIL = 500; // Most characters of a step's detail, which can name a host filled in from a hook's body: far below what an event holds.

// Where the hub's own machine, and a cloud's services for the machine it runs on, answer: loopback, link-local, where AWS, Azure, Google Cloud and Oracle give a machine its metadata
// at 169.254.169.254, and "this network"; and the addresses some clouds use besides. A name may lead to one only when the allow list names the address itself, IPv4-mapped included.
const NEARBY = new BlockList();
NEARBY.addSubnet("0.0.0.0", 8, "ipv4");
NEARBY.addSubnet("127.0.0.0", 8, "ipv4");
NEARBY.addSubnet("169.254.0.0", 16, "ipv4");
NEARBY.addAddress("::", "ipv6");
NEARBY.addAddress("::1", "ipv6");
NEARBY.addSubnet("fe80::", 10, "ipv6");
NEARBY.addAddress("fd00:ec2::254", "ipv6"); // AWS's metadata over IPv6.
NEARBY.addAddress("168.63.129.16", "ipv4"); // Azure's WireServer, which hands a machine its configuration and answers its health checks.
NEARBY.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud's metadata.

type Outcome = readonly [RunStatus, string];
type Webhook = Extract<Step, { readonly kind: "webhook" }>["webhook"];

/** A call the allow list does not let the hub make, found only once a name is looked up. */
class Refused extends Error {}

/** What an event stored in a channel would set off: which triggers it fires, and the values a run it sets off fills its templates with. */
interface Firing {
  readonly fires: (on: Trigger) => boolean;
  readonly values: Values;
}

/**
 * `text`, which a workflow's `template` was filled into, with every tag in it but those the template wrote made no tag by writing its "@" as a fullwidth "＠": so a value filled in, from
 * a webhook's body or someone's message, never tags an agent, and what a workflow can tag is in its file. It reads as it did, and is as long.
 */
function untagged(template: string, text: string): string {
  const written = new Set(mentions(template).map(([owner, repo]) => `${owner}/${repo}`));
  return spans(text)
    .map((part) => (part.tag && !written.has(part.text.slice(1).toLowerCase()) ? `＠${part.text.slice(1)}` : part.text))
    .join("");
}

/**
 * The hosts PLAYER_TWO_WEBHOOK_ALLOW lists, separated by commas, each as a URL writes its host: a name, which lets the hub call it and every name under it, or an IP address, IPv6 in brackets,
 * which lets it call that address and no other. Nothing listed lets it call nothing. Throws, saying which, for an entry that is neither, one with a port, or a pattern such as "*.example.com".
 */
export function allowList(text: string): readonly string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const url = /^[^\s/?#@\\:*[\]]+$|^\[[0-9A-Fa-f:.]+\]$/.test(entry) ? URL.parse(`https://${entry}`) : null;
      if (url === null) {
        throw new Error(`${entry} is not a host name or an IP address; a name lets the hub call every name under it, so example.com rather than *.example.com`);
      }
      return url.hostname; // Written as the address it is checked against will be: lowercase, IPv4 in four decimal parts, a name in punycode.
    });
}

/**
 * Why a webhook step may not call `address`, filled in; "" when it may. With nothing allowed, nothing is called. Then the address must have no user name or password, and its host be on
 * the list: a name equal to a name listed or under one, at a dot, so neither evil-example.com nor example.com.evil.com is under example.com; or an IP address listed exactly, however it
 * was written, since a URL reads a host whose last part is a number as an address, so no name ends in one and no address in a name. `https` goes to any of those; `http`, which anyone on
 * the way can read and change, only to a host the list names exactly.
 */
export function refusal(address: string, allow: readonly string[]): string {
  const url = URL.parse(address);
  if (allow.length === 0) {
    return `${ALLOW} is not set, so the hub calls no address`;
  }
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return "not an https or http address once filled in";
  }
  if (url.username !== "" || url.password !== "") {
    return "an address with a user name or password in it is never called";
  }
  const host = url.hostname;
  if (!allow.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return `${host} is not on ${ALLOW}`;
  }
  return url.protocol === "http:" && !allow.includes(host) ? `http goes only to a host ${ALLOW} names exactly, which ${host} is under; use https` : "";
}

/**
 * Look a name up as the system does, and refuse it when an address it has is NEARBY and not on the list. The connection is made to an address looked at here, so a name that answers
 * differently the next time it is asked cannot lead the call elsewhere after it was let through. A lookup that fails, or throws, is the call's error: this runs outside any request or
 * promise, where a throw would end the hub.
 */
export function lookupWithin(allow: readonly string[]): LookupFunction {
  return (hostname, options, callback) => {
    try {
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error !== null) {
          callback(error, []); // A failed lookup has no addresses to look at.
          return;
        }
        const near = addresses.find(({ address, family }) => NEARBY.check(address, family === 6 ? "ipv6" : "ipv4") && !allow.includes(family === 6 ? `[${address}]` : address));
        if (near !== undefined) {
          callback(new Refused(`${hostname} is at ${near.address}, which the hub calls only when ${ALLOW} names that address`), []);
        } else if (options.all === true) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0]?.address ?? "", addresses[0]?.family ?? 4);
        }
      });
    } catch (error) {
      callback(error instanceof Error ? error : new Error("the lookup failed"), []); // Arguments it would not take; it called nothing back.
    }
  };
}

/** Why a call came to nothing: its time ran out, the hub stopped, or what the system said, by its code alone, so that nothing of what is around the hub is written into the chat. */
function failure(host: string, error: unknown, signal: AbortSignal): string {
  if (signal.aborted) {
    return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? `${host} did not answer within ${String(CALL_TIME)} seconds` : "the hub stopped during this step";
  }
  return `could not call ${host}: ${error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "the connection failed"}`;
}

/**
 * POST `body` to `url`, following no redirect, reading at most MAX_ANSWER of the answer and keeping none of it, until `signal` ends it: done for a 2xx, failed for anything else. Never
 * through a proxy: the call has an agent of its own, where Node's own would send it through one the hub's environment names (NODE_USE_ENV_PROXY with HTTP_PROXY or HTTPS_PROXY), which
 * looks the name up itself, past `lookupWithin`.
 */
function call(url: URL, body: string, type: string, allow: readonly string[], signal: AbortSignal): Promise<Outcome> {
  return new Promise((resolve) => {
    const [send, agent] = url.protocol === "https:" ? [httpsRequest, new HttpsAgent()] : [httpRequest, new HttpAgent()];
    const asked = send(url, { method: "POST", headers: { "Content-Type": type, "User-Agent": "player-two-hub" }, agent, lookup: lookupWithin(allow), signal }, (answer) => {
      let read = 0;
      answer.on("data", (chunk: Buffer) => {
        read += chunk.length;
        if (read > MAX_ANSWER) {
          resolve(["failed", `${url.host} answered with more than 1 MB`]);
          asked.destroy();
        }
      });
      answer.on("error", () => undefined); // Said by "close", which follows.
      answer.on("close", () => {
        const status = answer.statusCode ?? 0;
        const redirect = status >= 300 && status < 400 ? ", and the hub follows no redirect" : "";
        resolve(!answer.complete ? ["failed", failure(url.host, null, signal)] : status >= 200 && status < 300 ? ["done", ""] : ["failed", `${url.host} answered ${String(status)}${redirect}`]);
      });
    });
    asked.on("error", (error) => {
      resolve(error instanceof Refused ? ["refused", error.message] : ["failed", failure(url.host, error, signal)]);
    });
    asked.end(body);
  });
}

/** `detail` at most MAX_DETAIL characters, cut in its middle, so that a reason naming a long host still ends as it was written. */
function short(detail: string): string {
  const chars = Array.from(detail);
  return chars.length <= MAX_DETAIL ? detail : `${chars.slice(0, MAX_DETAIL / 2).join("")}…${chars.slice(1 - MAX_DETAIL / 2).join("")}`;
}

/** Whether text is JSON as it is. */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the workflows live in the hub's database, signing what they do with `key` as the hub, calling only the hosts `allow` lists from a webhook step (see `allowList`), and calling `wake`
 * once something is stored.
 */
export function runWorkflows(db: Database, key: KeyObject, now: () => number, allow: readonly string[], wake: () => void, log: Log): Workflows {
  let files = new Map<string, Workflow>(); // Each live workflow's file as it reads, by the id of its definition, which never changes what it holds. `schedule` keeps it to those live.
  const closing = new AbortController(); // Hangs up every webhook being called once the hub stops.
  let crons: Cron[] = [];

  function failed(error: unknown): void {
    log("workflow failed", { error: problemOf(error) });
  }

  function fileOf(live: Live): Workflow {
    const known = files.get(live.event) ?? parseWorkflow(live.yaml); // It read when the hub took it, or it would not be live.
    files.set(live.event, known);
    return known;
  }

  /** An event of the hub's own, to a channel, at `ts`. */
  function signed<K extends "message" | "workflow.run">(to: string, kind: K, content: ContentOf<K>, refs: readonly string[], ts: number): Event {
    return signEvent(key, { author: HUB, to, kind, content: JSON.stringify(content), ts, refs });
  }

  /**
   * Record what step `step` of a run did: the message it posts, when it posts one, and the workflow.run saying how it came out, which refers to the run's definition and to that message,
   * or to `about`, the message an approval waited on; stored with the run's new place in one transaction, so that a hub stopped at any moment holds a step whole or not at all, and a run
   * set waiting waits on the message posted with it. The events then pass the triggers, as everyone's do.
   */
  function record(ref: Ref, step: number, status: RunStatus, detail: string, place: Place, text: string | null = null, about = ""): void {
    const ts = Math.floor(now());
    const posted = text === null ? null : signed(ref.channel, "message", { text, via: "workflow", workflow: ref.name }, [], ts);
    const second = posted?.id ?? about;
    const report = signed(ref.channel, "workflow.run", { workflow: ref.name, run: ref.run, step, status, detail: short(detail) }, second === "" ? [ref.definition] : [ref.definition, second], ts);
    const stored = [posted, report].filter((event) => event !== null);
    db.transaction(() => {
      for (const event of stored) {
        db.addEvent(event);
      }
      db.saveRun(ref.run, place.step, place.state, place.state === "waiting" ? second : "", place.state === "waiting" ? ts + (place.within ?? 0) : 0);
    });
    wake();
    log("workflow step", { channel: ref.channel, workflow: ref.name, run: ref.run, step, status });
    stored.forEach(seen);
  }

  /** The place after step `at`: the next step, or the end after the last. */
  function onward(going: Going, at: number): Place {
    return { step: at + 1, state: at + 1 < going.file.steps.length ? "running" : "ended" };
  }

  /** What a message the hub posts for a run says: its template filled in, cut to fit an event, tagging only the agents its template names; cut first, as cutting can leave part of a tag at the end. */
  function told(template: string, values: Values): string {
    return untagged(template, fitText(fill(template, values)));
  }

  /**
   * Take step `at` of a run, one that takes no time, and record how it came out: whether the run goes on to the next. A text that is empty once filled in, as a value filled in was,
   * fails the step: a message holds at least one character, and one that does not is no message any reader takes.
   */
  function took(going: Going, at: number, step: Step): boolean {
    if (step.if !== undefined && !holds(step.if, going.values)) {
      record(going, at, "skipped", "", onward(going, at));
      return true;
    }
    if (step.kind === "webhook") {
      return false; // One whose `if` holds is `called`.
    }
    const text = told(step.kind === "post" ? step.post : step.kind === "tag" ? `${step.tag} ${step.text}` : step.approve.text, going.values);
    if (text === "") {
      record(going, at, "failed", "its text is empty once filled in", { step: at, state: "ended" });
      return false;
    }
    if (step.kind === "approve") {
      const from = step.approve.from === "anyone" ? `anyone in ${going.channel}` : step.approve.from;
      record(going, at, "waiting", `for a 👍 from ${from}`, { step: at, state: "waiting", within: step.approve.within }, text);
      return false; // Until `approve` hears the 👍, or `sweep` finds the time has passed.
    }
    // A tag is a message like a person's, and the step ends once it is stored: the job it makes waits for the agent's owner, or a grant naming the workflow, on their own desk.
    record(going, at, "done", "", onward(going, at), text);
    return true;
  }

  /** Why a run can no longer go on: its workflow replaced or removed since it began; "" while the file it started under is live. */
  function changed(ref: Ref): string {
    const live = db.liveWorkflows(ref.channel).find((each) => each.name === ref.name);
    return live?.event === ref.definition ? "" : `${ref.name} was ${live === undefined ? "removed" : "replaced"}`;
  }

  /**
   * Take a webhook step: POST its body to its address, both filled in, once `refusal` lets it, and record how that came out once it has; whether the run goes on to the next. A value is
   * filled into the address percent-encoded, so it is one part of it and cannot add a path, a query, a port or a user, and the allow list is checked on the address as filled in. A body
   * that is JSON as written has each value filled in as JSON string content, which keeps it the JSON it was; any other is sent as text. A run whose workflow changed while it waited goes no further.
   */
  async function called(going: Going, at: number, webhook: Webhook): Promise<boolean> {
    const address = fill(webhook.url, going.values, encodeURIComponent);
    const url = URL.parse(address);
    const why = refusal(address, allow);
    const json = isJson(webhook.body ?? "");
    const body = fill(webhook.body ?? "", going.values, json ? (value) => JSON.stringify(value).slice(1, -1) : (value) => value);
    const signal = AbortSignal.any([closing.signal, AbortSignal.timeout(CALL_TIME * 1000)]);
    const [status, detail]: Outcome = why !== "" || url === null ? ["refused", why] : await call(url, body, json ? "application/json" : "text/plain; charset=utf-8", allow, signal);
    if (closing.signal.aborted) {
      return false; // The database has closed. The run's row says it is at this step, and the hub ends it there when it starts again.
    }
    const gone = changed(going);
    const goes = status === "done" && gone === "";
    record(going, at, status, detail, goes ? onward(going, at) : { step: at, state: "ended" });
    if (status === "done" && gone !== "" && at + 1 < going.file.steps.length) {
      record(going, at + 1, "cancelled", gone, { step: at + 1, state: "ended" });
    }
    return goes;
  }

  /**
   * Take a run's steps one at a time from `from`, each recorded as it ends. Steps that take no time are taken before this returns its promise. A step that throws, such as one filling a
   * value no address can hold into a webhook's, ends its run as failed, said in the channel, rather than leaving it running with nothing said; why is the hub's log's.
   */
  async function go(going: Going, from: number): Promise<void> {
    for (let at = from; at < going.file.steps.length; at += 1) {
      const step = going.file.steps[at];
      if (step === undefined) {
        return;
      }
      let goes = false;
      try {
        const calls = step.kind === "webhook" && (step.if === undefined || holds(step.if, going.values));
        goes = calls ? await called(going, at, step.webhook) : took(going, at, step);
      } catch (error) {
        failed(error);
        record(going, at, "failed", "the hub could not take this step", { step: at, state: "ended" });
      }
      if (!goes) {
        return;
      }
    }
  }

  /** A run kept in workflow_runs, to go on with: null when the definition it runs is no longer live. */
  function resumed(run: Run): Going | null {
    const live = db.liveWorkflows(run.channel).find((each) => each.event === run.definition);
    return live === undefined ? null : { run: run.run, channel: run.channel, name: run.name, definition: run.definition, file: fileOf(live), values: run.input };
  }

  /** A 👍 added to the message a run waits on, by the person its step names, or by anyone when it names `anyone`, moves the run on; past the step's time, it ends as expired. */
  function approve(event: Event, said: Content | { readonly kind: "unknown" }): void {
    if (said.kind !== "reaction" || !said.content.on || !THUMBS_UP.test(said.content.emoji)) {
      return;
    }
    const run = db.runsIn("waiting").find((each) => each.approval === event.refs[0] && each.channel === event.to);
    const going = run === undefined ? null : resumed(run);
    if (run === undefined || going === null) {
      return; // Not a message a run waits on; or one whose workflow has gone, which `sweep` ends.
    }
    const step = going.file.steps[run.step];
    if (step?.kind !== "approve" || (step.approve.from !== "anyone" && step.approve.from !== event.author)) {
      return; // Anyone else's is a reaction like any other.
    }
    if (now() > run.until) {
      record(going, run.step, "expired", "no 👍 came in time", { step: run.step, state: "ended" }, null, run.approval);
      return;
    }
    record(going, run.step, "approved", `by ${event.author}`, onward(going, run.step), null, run.approval);
    go(going, run.step + 1).catch(failed);
  }

  /**
   * End each waiting run that can no longer go on: one whose workflow has been replaced or removed since it began is cancelled, as a run goes on only as the file it started under says;
   * one whose time has passed, expired. The hub looks when it starts, every minute after, and when a workflow changes, so a wait outlasts the hub stopping and starting.
   */
  function sweep(): void {
    for (const run of db.runsIn("waiting")) {
      const gone = changed(run);
      const end: Place = { step: run.step, state: "ended" };
      if (gone !== "") {
        record(run, run.step, "cancelled", gone, end, null, run.approval);
      } else if (now() > run.until) {
        record(run, run.step, "expired", "no 👍 came in time", end, null, run.approval);
      }
    }
  }

  /** Why a workflow may not start a run at `ts`, as it has started as many as it may in the hour before or has as many waiting as it may, "" when it may; and whether its newest run was throttled. */
  function limit(live: Live, ts: number): { readonly full: string; readonly again: boolean } {
    const { lately, waiting, last } = db.runCounts(live.channel, live.name, ts - 3_600);
    const most = "the most it may";
    const full =
      lately >= HOURLY ? `${live.name} has started ${String(HOURLY)} runs in the last hour, ${most}` : waiting >= WAITING ? `${live.name} has ${String(WAITING)} runs waiting for a 👍, ${most}` : "";
    return { full, again: last === "throttled" };
  }

  /**
   * Set off a run of a live workflow with the values its templates are filled from; or, past a limit, record it as throttled, having done nothing. Only the first run throttled since one
   * last started is recorded, so that calling a hook again and again cannot fill the channel; those after it leave no trace. A failure is the hub's to log: whatever set the run off is not told.
   */
  function start(live: Live, values: Values): void {
    try {
      const ts = Math.floor(now());
      const { full, again } = limit(live, ts);
      if (full !== "" && again) {
        return;
      }
      const run = db.addRun(live, full === "" ? values : {}, ts, full === "" ? "running" : "throttled");
      const going = { run, channel: live.channel, name: live.name, definition: live.event, file: fileOf(live), values };
      if (full === "") {
        go(going, 0).catch(failed);
      } else {
        record(going, 0, "throttled", full, { step: 0, state: "throttled" });
      }
    } catch (error) {
      failed(error);
    }
  }

  /** What a person's message or reaction stored in `channel` sets off. A reaction fires only as it is added, and only on a message in that channel, whose text a run is then given. */
  function firing(event: Event, said: Content | { readonly kind: "unknown" }): Firing | null {
    const values = (text: string): Values => ({ trigger: { text, author: event.author } });
    if (said.kind === "message") {
      return { fires: (on) => on.kind === "message" && said.content.text.includes(on.message.contains), values: values(said.content.text) };
    }
    if (said.kind !== "reaction" || !said.content.on) {
      return null;
    }
    const target = db.event(event.author, event.refs[0] ?? "");
    const message = target?.event.to === event.to ? readContent(target.event) : null;
    return message?.kind !== "message" ? null : { fires: (on) => on.kind === "reaction" && on.reaction.emoji === said.content.emoji, values: values(message.content.text) };
  }

  /** Set off the runs an event stored in a channel calls for, and keep the schedules as the channel's workflows are. The hub's own events, and agents', set nothing off. */
  function trigger(event: Event): void {
    if (event.author === HUB || isAgent(event.author) || !isChannel(event.to)) {
      return;
    }
    const said = readContent(event);
    if (said.kind === "workflow.define" || said.kind === "workflow.remove") {
      schedule();
      sweep();
      return;
    }
    approve(event, said);
    const fired = firing(event, said);
    for (const live of fired === null ? [] : db.liveWorkflows(event.to)) {
      if (fired?.fires(fileOf(live).on) === true) {
        start(live, fired.values);
      }
    }
  }

  function seen(event: Event): void {
    try {
      trigger(event);
    } catch (error) {
      log("workflow failed", { event: event.id, error: problemOf(error) });
    }
  }

  /**
   * Time each live workflow with a schedule, in place of every timer before, and keep parsed the files of those live and no others, whose definitions nothing asks for again. Each is
   * named by its definition's id, which a test sets off by. croner reads the system's clock in the workflow's time zone, and a time that passed while the hub was down is not made up.
   */
  function schedule(): void {
    for (const cron of crons) {
      cron.stop();
    }
    const lives = db.liveWorkflows();
    files = new Map(lives.map((live) => [live.event, fileOf(live)])); // Read from those kept before, so a file is parsed once while it is live.
    crons = lives.flatMap((live) => {
      const { on } = fileOf(live);
      return on.kind === "schedule"
        ? [
            new Cron(on.schedule.cron, { name: live.event, timezone: on.schedule.zone, mode: "5-part", unref: true }, () => {
              start(live, {});
            })
          ]
        : [];
    });
  }

  // A run the hub stopped in the middle of a step, a webhook being called, is not taken up again: whether the call did what it does is not known, so the run ends there.
  for (const run of db.runsIn("running")) {
    record(run, run.step, "failed", "the hub stopped during this step", { step: run.step, state: "ended" });
  }
  schedule();
  sweep();
  const sweeping = setInterval(() => {
    try {
      sweep();
    } catch (error) {
      log("workflow failed", { error: problemOf(error) });
    }
  }, SWEEP * 1000).unref();

  return {
    seen,
    hook: (id) => {
      const live = db.liveWorkflows().find((each) => each.event.startsWith(id));
      const on = live === undefined ? null : fileOf(live).on;
      if (live === undefined || on?.kind !== "webhook") {
        return null;
      }
      return {
        secret: on.webhook.secret ?? null,
        start: (body) => {
          start(live, { body });
        }
      };
    },
    stop: () => {
      closing.abort();
      clearInterval(sweeping);
      for (const cron of crons) {
        cron.stop();
      }
    },
    parsed: () => files.size
  };
}
