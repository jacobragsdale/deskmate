/** Reading a workflow file: each trigger and step, what a bad file is told, and filling in templates and conditions. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fill, holds, parseWorkflow } from "../src/core/workflow.ts";
import type { Values } from "../src/core/workflow.ts";

// The example in the plan, docs/plan/phase-7-workflows.md.
const EXAMPLE = `name: ci-failure
on:
  webhook: {}                       # or  message: { contains: "P1" }
steps:
  - post: "The build failed on {{body.branch}}: {{body.url}}"
  - approve: { from: jacob, text: "Ask the uploader agent what broke?" }
  - tag: "@jacob/uploader"
    text: "The build at {{body.url}} failed. What broke?"
  - webhook: { url: "https://ci.corp.internal/retry", body: '{"build": "{{body.id}}"}' }
    if: { equals: ["{{body.retry}}", "true"] }
`;

/** A file with this trigger and these steps, each written as the YAML of one list item. */
function file(on: string, ...steps: string[]): string {
  return `name: test\non: ${on}\nsteps:\n${steps.map((step) => `  - ${step}\n`).join("")}`;
}

/** What a bad file is told, or "read" when it is read after all. */
function refusal(source: string): string {
  try {
    parseWorkflow(source);
    return "read";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

await test("the plan's example reads into a definition", () => {
  assert.deepEqual(parseWorkflow(EXAMPLE), {
    name: "ci-failure",
    on: { kind: "webhook", webhook: {} },
    steps: [
      { kind: "post", post: "The build failed on {{body.branch}}: {{body.url}}" },
      { kind: "approve", approve: { from: "jacob", text: "Ask the uploader agent what broke?", within: 86_400 } },
      { kind: "tag", tag: "@jacob/uploader", text: "The build at {{body.url}} failed. What broke?" },
      { kind: "webhook", webhook: { url: "https://ci.corp.internal/retry", body: '{"build": "{{body.id}}"}' }, if: { kind: "equals", equals: ["{{body.retry}}", "true"] } }
    ]
  });
});

await test("each trigger reads", () => {
  const triggers = [
    ["{ webhook: { secret: s3cret } }", { kind: "webhook", webhook: { secret: "s3cret" } }],
    ['{ message: { contains: "P1" } }', { kind: "message", message: { contains: "P1" } }],
    ['{ reaction: { emoji: "🚀" } }', { kind: "reaction", reaction: { emoji: "🚀" } }],
    ['{ schedule: { cron: "0 9 * * 1-5", zone: "Europe/London" } }', { kind: "schedule", schedule: { cron: "0 9 * * 1-5", zone: "Europe/London" } }]
  ] as const;
  for (const [on, read] of triggers) {
    assert.deepEqual(parseWorkflow(file(on, "post: hi")).on, read, on);
  }
});

await test("each step reads", () => {
  const steps = [
    ['post: "{{trigger.author}} said {{trigger.text}}"', { kind: "post", post: "{{trigger.author}} said {{trigger.text}}" }],
    ['tag: "@jacob/uploader"\n    text: "What broke?"', { kind: "tag", tag: "@jacob/uploader", text: "What broke?" }],
    ["approve: { from: anyone, text: Go?, within: 90m }", { kind: "approve", approve: { from: "anyone", text: "Go?", within: 5_400 } }],
    ["approve: { from: jacob, text: Go?, within: 12h }", { kind: "approve", approve: { from: "jacob", text: "Go?", within: 43_200 } }],
    ["approve: { from: jacob, text: Go?, within: 2d }", { kind: "approve", approve: { from: "jacob", text: "Go?", within: 172_800 } }],
    ["webhook: { url: http://ci.corp.internal/retry }", { kind: "webhook", webhook: { url: "http://ci.corp.internal/retry" } }],
    ['post: hi\n    if: { contains: ["{{trigger.text}}", "urgent"] }', { kind: "post", post: "hi", if: { kind: "contains", contains: ["{{trigger.text}}", "urgent"] } }]
  ] as const;
  for (const [step, read] of steps) {
    assert.deepEqual(parseWorkflow(file("{ webhook: {} }", step)).steps, [read], step);
  }
});

await test("a bad file is told which line is wrong and why", () => {
  const twentyOne = file("{ webhook: {} }", ...Array.from({ length: 21 }, () => "post: hi"));
  const cases = [
    [EXAMPLE.replace("name: ci-failure", "name: ci-failure\ncolour: red"), 'line 2: Unrecognized key: "colour"'],
    [EXAMPLE.replace("{ from: jacob,", "{ from: jacob, form: bob,"), 'line 6: steps.1.approve: Unrecognized key: "form"'],
    [EXAMPLE.replace("    text: ", "    txt: "), "line 7: steps.2.text: required"],
    [EXAMPLE.replace("  - post:", "  - pots:"), "line 5: steps.0: a step has exactly one of post, tag, approve, webhook"],
    [EXAMPLE.replace("  - post:", '  - tag: "@jacob/uploader"\n    post:'), "line 5: steps.0: a step has exactly one of post, tag, approve, webhook"],
    [EXAMPLE.replace("  - post:", "  - kind: post\n    post:"), 'line 5: steps.0: Unrecognized key: "kind"'],
    [EXAMPLE.replace("webhook: {}", "webhook: {}\n  message: { contains: P1 }"), "line 2: on: a trigger has exactly one of webhook, message, reaction, schedule"],
    [EXAMPLE.replace("webhook: {}", "webhook: { secret: '' }"), "line 3: on.webhook.secret: Too small: expected string to have >=1 characters"],
    [file('{ schedule: { cron: "61 9 * * *", zone: UTC } }', "post: hi"), "line 2: on.schedule.cron: Invalid value for minute: 61"],
    [file('{ schedule: { cron: "0 0 9 * * *", zone: UTC } }', "post: hi"), "line 2: on.schedule.cron: mode '5-part' requires exactly 5 parts, but pattern '0 0 9 * * *' has 6 parts."],
    [file('{ schedule: { cron: "0 9 * * *", zone: Mars/Olympus } }', "post: hi"), "line 2: on.schedule.zone: not a time zone, such as Europe/London or UTC"],
    [file('{ schedule: { cron: "0 9 * * *" } }', "post: hi"), "line 2: on.schedule.zone: required"],
    [EXAMPLE.replace('"@jacob/uploader"', "uploader"), 'line 7: steps.2.tag: an agent, such as "@jacob/uploader"'],
    [EXAMPLE.replace("from: jacob,", "from: jacob, within: 2 hours,"), 'line 6: steps.1.approve.within: a number and m, h or d, such as "2h"'],
    [EXAMPLE.replace("https://ci", "file://ci"), "line 9: steps.3.webhook.url: an https or http address"],
    [EXAMPLE.replace("equals:", "matches:"), "line 10: steps.3.if: a condition has exactly one of equals, contains"],
    [EXAMPLE.replace('"true"', "true"), "line 10: steps.3.if.equals.1: Invalid input: expected string, received boolean"],
    [twentyOne, "line 3: steps: a workflow has at most 20 steps"],
    [file("{ webhook: {} }").replace("steps:", "steps: []"), "line 3: steps: Too small: expected array to have >=1 items"],
    [EXAMPLE.replace("{ from: jacob,", "{ from: jacob, from: bob,"), "line 6: Map keys must be unique"],
    [EXAMPLE.replace("  - tag:", "  - tag: x: y"), "line 7: Nested mappings are not allowed in compact mappings"],
    ["", "line 1: Invalid input: expected object, received null"],
    ["- post: hi\n", "line 1: Invalid input: expected object, received array"],
    // Ten aliases of ten of ten of ten: yaml's limit on aliases stops it before it makes ten thousand of anything.
    [
      "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\n",
      "line 1: Excessive alias count indicates a resource exhaustion attack"
    ]
  ] as const;
  for (const [source, said] of cases) {
    assert.equal(refusal(source), said, source);
  }
  assert.equal(refusal(file("{ webhook: {} }", ...Array.from({ length: 20 }, () => "post: hi"))), "read");
});

await test("a template is filled in one pass, and an unknown name is left as written", () => {
  const values: Values = { trigger: { text: "the {{body.id}} build", author: "jacob" }, body: { id: 7, ok: false, branch: "main", commits: [{ id: "abc" }], meta: { tag: null } } };
  const cases = [
    ["{{trigger.author}} said: {{trigger.text}}", "jacob said: the {{body.id}} build"], // What was filled in is not read again.
    ["{{body.branch}} #{{body.id}} ok={{body.ok}} first={{ body.commits.0.id }}", "main #7 ok=false first=abc"],
    ["{{body.missing}} {{body.meta}} {{body.meta.tag}} {{body}} {{nope}} {{}}", "{{body.missing}} {{body.meta}} {{body.meta.tag}} {{body}} {{nope}} {{}}"], // Only a string, a number or true/false is filled in.
    ["{{body.branch.length}} {{body.constructor}} {{trigger.text.length}}", "{{body.branch.length}} {{body.constructor}} {{trigger.text.length}}"], // Only what the values hold themselves.
    ["{{{body.branch}}} {{body.branch}", "{main} {{body.branch}"],
    ["no templates", "no templates"]
  ] as const;
  for (const [template, filled] of cases) {
    assert.equal(fill(template, values), filled, template);
  }
  assert.equal(
    fill("{{body.branch}}/{{body.id}}/{{nope}}", values, (value) => `<${value}>`),
    "<main>/<7>/{{nope}}"
  ); // Each value written as where it goes needs; what is left as written is not.
});

await test("a condition compares its two templates once they are filled in", () => {
  const values: Values = { trigger: { text: "an URGENT fix" }, body: { retry: "true", count: 3 } };
  const workflow = parseWorkflow(
    file(
      "{ webhook: {} }",
      'post: a\n    if: { equals: ["{{body.retry}}", "true"] }',
      'post: b\n    if: { equals: ["{{body.count}}", "4"] }',
      'post: c\n    if: { contains: ["{{trigger.text}}", "URGENT"] }',
      'post: d\n    if: { contains: ["{{trigger.text}}", "urgent"] }',
      'post: e\n    if: { equals: ["{{body.unknown}}", "{{body.unknown}}"] }'
    )
  );
  assert.deepEqual(
    workflow.steps.map((step) => step.if !== undefined && holds(step.if, values)),
    [true, false, true, false, true]
  );
});
