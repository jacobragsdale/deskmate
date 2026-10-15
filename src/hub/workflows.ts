/**
 * The hub running each channel's workflows. A run is a row in workflow_runs; its steps are taken one at a time, and after each the hub signs a workflow.run saying how it came out,
 * stored with whatever the step posted and the row's new place in one transaction. The hub never runs an agent: what it posts is a message like anyone's.
 */

import type { KeyObject } from "node:crypto";

import { readContent } from "../core/kinds.ts";
import type { ContentOf, RunStatus } from "../core/kinds.ts";
import { signEvent } from "../core/sign.ts";
import { fill, holds, parseWorkflow } from "../core/workflow.ts";
import type { Values, Workflow } from "../core/workflow.ts";
import { fitText, HUB, isAgent, isChannel } from "../core/wire.ts";
import type { Event } from "../core/wire.ts";
import type { Log } from "./app.ts";
import type { Database, Live, Run, RunState } from "./db.ts";

/** What the hub does with workflows, once it has opened its database. */
export interface Workflows {
  /** Act on an event the hub has just stored, whoever signed it: a trigger it matches sets a run off. Never throws, as the event is kept whatever a run does. */
  readonly seen: (event: Event) => void;
}

/** Which run a step is of: its number, and the channel, name and definition of the workflow it runs, as its row has them. */
type Ref = Pick<Run, "run" | "channel" | "name" | "definition">;

/** A run under way: which it is, the file it runs, and the values its templates are filled from. */
interface Going extends Ref {
  readonly file: Workflow;
  readonly values: Values;
}

/** Where a run is once a step has been recorded: the step it is at, and its state. */
interface Place {
  readonly step: number;
  readonly state: RunState;
}

function problem(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run the workflows live in the hub's database, signing what they do with `key` as the hub, and calling `wake` once something is stored. */
export function runWorkflows(db: Database, key: KeyObject, now: () => number, wake: () => void, log: Log): Workflows {
  const files = new Map<string, Workflow>(); // Each file as it reads, by the id of its definition, which never changes what it holds.

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
   * Record what step `step` of a run did: the message it posts, when it posts one, and the workflow.run saying how it came out, which refers to the run's definition and to that message;
   * stored with the run's new place in one transaction, so that a hub stopped at any moment holds a step whole or not at all. The events then pass the triggers, as everyone's do.
   */
  function record(ref: Ref, step: number, status: RunStatus, detail: string, place: Place, text: string | null = null): void {
    const ts = Math.floor(now());
    const posted = text === null ? null : signed(ref.channel, "message", { text, via: "workflow", workflow: ref.name }, [], ts);
    const refs = [ref.definition, ...(posted === null ? [] : [posted.id])];
    const report = signed(ref.channel, "workflow.run", { workflow: ref.name, run: ref.run, step, status, detail }, refs, ts);
    const stored = [posted, report].filter((event) => event !== null);
    db.transaction(() => {
      for (const event of stored) {
        db.addEvent(event);
      }
      db.saveRun(ref.run, place.step, place.state);
    });
    wake();
    log("workflow step", { channel: ref.channel, workflow: ref.name, run: ref.run, step, status });
    stored.forEach(seen);
  }

  /** The place after step `at`: the next step, or the end after the last. */
  function onward(going: Going, at: number): Place {
    return { step: at + 1, state: at + 1 < going.file.steps.length ? "running" : "ended" };
  }

  /** What a message the hub posts for a run says: its template filled in, cut to fit an event. */
  function told(template: string, values: Values): string {
    return fitText(fill(template, values));
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
      } else if (step.kind === "post") {
        record(going, at, "done", "", onward(going, at), told(step.post, going.values));
      } else {
        record(going, at, "failed", `this hub does not yet take ${step.kind} steps`, { step: at, state: "ended" });
        return;
      }
    }
  }

  /** Set off a run of a live workflow with the values its templates are filled from. */
  function start(live: Live, values: Values): void {
    const going = { run: db.addRun(live, values, Math.floor(now()), "running"), channel: live.channel, name: live.name, definition: live.event, file: fileOf(live), values };
    go(going, 0);
  }

  /** Set off the runs an event stored in a channel calls for. The hub's own events, and agents', set nothing off. */
  function trigger(event: Event): void {
    if (event.author === HUB || isAgent(event.author) || !isChannel(event.to)) {
      return;
    }
    const said = readContent(event);
    for (const live of said.kind === "message" ? db.liveWorkflows(event.to) : []) {
      const { on } = fileOf(live);
      if (said.kind === "message" && on.kind === "message" && said.content.text.includes(on.message.contains)) {
        start(live, { trigger: { text: said.content.text, author: event.author } });
      }
    }
  }

  function seen(event: Event): void {
    try {
      trigger(event);
    } catch (error) {
      log("workflow failed", { event: event.id, error: problem(error) });
    }
  }

  return { seen };
}
