/**
 * The hub running each channel's workflows. A run is a row in workflow_runs; its steps are taken one at a time, and after each the hub signs a workflow.run saying how it came out,
 * stored with whatever the step posted and the row's new place in one transaction. The hub never runs an agent: what it posts is a message like anyone's.
 */

import type { KeyObject } from "node:crypto";

import { Cron } from "croner";

import { mentions, spans } from "../core/chat.ts";
import { readContent } from "../core/kinds.ts";
import type { Content, ContentOf, RunStatus } from "../core/kinds.ts";
import { signEvent } from "../core/sign.ts";
import { problemOf } from "../core/text.ts";
import { fill, holds, parseWorkflow } from "../core/workflow.ts";
import type { Trigger, Values, Workflow } from "../core/workflow.ts";
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
  /** Stop for good, as the hub closes: no schedule fires after, and no wait is checked. */
  readonly stop: () => void;
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

/** What an event stored in a channel would set off: which triggers it fires, and the values a run it sets off fills its templates with. */
interface Firing {
  readonly fires: (on: Trigger) => boolean;
  readonly values: Values;
}

/**
 * `text`, which a workflow's `template` was filled into, with every tag in it but those the template wrote made no tag by writing its "@" as a fullwidth "＠": so a value filled in, from
 * a webhook's body or someone's message, never tags an agent, and what a workflow can tag is in its file. It reads as it did, and is no longer.
 */
function untagged(template: string, text: string): string {
  const written = new Set(mentions(template).map(([owner, repo]) => `${owner}/${repo}`));
  return spans(text)
    .map((part) => (part.tag && !written.has(part.text.slice(1).toLowerCase()) ? `＠${part.text.slice(1)}` : part.text))
    .join("");
}

/** Run the workflows live in the hub's database, signing what they do with `key` as the hub, and calling `wake` once something is stored. */
export function runWorkflows(db: Database, key: KeyObject, now: () => number, wake: () => void, log: Log): Workflows {
  const files = new Map<string, Workflow>(); // Each file as it reads, by the id of its definition, which never changes what it holds.
  let crons: Cron[] = [];

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
    const report = signed(ref.channel, "workflow.run", { workflow: ref.name, run: ref.run, step, status, detail }, second === "" ? [ref.definition] : [ref.definition, second], ts);
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

  /** Take a run's steps one at a time from `from`, each recorded as it ends. */
  function go(going: Going, from: number): void {
    for (let at = from; at < going.file.steps.length; at += 1) {
      const step = going.file.steps[at];
      if (step === undefined) {
        return;
      }
      if (step.if !== undefined && !holds(step.if, going.values)) {
        record(going, at, "skipped", "", onward(going, at));
      } else if (step.kind === "post" || step.kind === "tag") {
        // A tag is a message like a person's, and the step ends once it is stored: the job it makes waits for the agent's owner, or a grant naming the workflow, on their own desk.
        record(going, at, "done", "", onward(going, at), told(step.kind === "post" ? step.post : `${step.tag} ${step.text}`, going.values));
      } else if (step.kind === "approve") {
        const from = step.approve.from === "anyone" ? `anyone in ${going.channel}` : step.approve.from;
        record(going, at, "waiting", `for a 👍 from ${from}`, { step: at, state: "waiting", within: step.approve.within }, told(step.approve.text, going.values));
        return; // Until `approve` hears the 👍, or `sweep` finds the time has passed.
      } else {
        record(going, at, "failed", `this hub does not yet take ${step.kind} steps`, { step: at, state: "ended" });
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
    go(going, run.step + 1);
  }

  /**
   * End each waiting run that can no longer go on: one whose workflow has been replaced or removed since it began is cancelled, as a run goes on only as the file it started under says;
   * one whose time has passed, expired. The hub looks when it starts, every minute after, and when a workflow changes, so a wait outlasts the hub stopping and starting.
   */
  function sweep(): void {
    for (const run of db.runsIn("waiting")) {
      const live = db.liveWorkflows(run.channel).find((each) => each.name === run.name);
      const end = { step: run.step, state: "ended" } as const;
      if (live?.event !== run.definition) {
        record(run, run.step, "cancelled", `${run.name} was ${live === undefined ? "removed" : "replaced"}`, end, null, run.approval);
      } else if (now() > run.until) {
        record(run, run.step, "expired", "no 👍 came in time", end, null, run.approval);
      }
    }
  }

  /** Set off a run of a live workflow with the values its templates are filled from. A failure is the hub's to log: whatever set the run off is not told. */
  function start(live: Live, values: Values): void {
    try {
      const going = { run: db.addRun(live, values, Math.floor(now()), "running"), channel: live.channel, name: live.name, definition: live.event, file: fileOf(live), values };
      go(going, 0);
    } catch (error) {
      log("workflow failed", { channel: live.channel, workflow: live.name, error: problemOf(error) });
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
   * Time each live workflow with a schedule, in place of every timer before. Each is named by its definition's id, which a test sets off by. croner reads the system's clock in the workflow's
   * time zone, and a time that passed while the hub was down is not made up.
   */
  function schedule(): void {
    for (const cron of crons) {
      cron.stop();
    }
    crons = db.liveWorkflows().flatMap((live) => {
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
      clearInterval(sweeping);
      for (const cron of crons) {
        cron.stop();
      }
    }
  };
}
