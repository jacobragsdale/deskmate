# Phase 7: workflows

Goal: small automations that live with a channel: when this happens, post that, tag this agent, wait for a thumbs-up. The hub runs the triggers. It never runs an agent: tagging one creates a job that waits for its owner or a grant, like any other.

Depends on: phase 6.

Borrowed from Buzz: YAML automation triggered by messages, reactions, schedules and webhooks. Buzz's approval gates are not finished; here an approval is a reaction the hub waits for, and the wait survives a restart.

## The design

**Definitions are signed events.** A member publishes a workflow to a channel as a `workflow.define` event holding the YAML text. The hub parses it and makes it live for that channel; `workflow.remove` takes it away. So who installed which automation, and when, is in the log like everything else. The hub never reads a git repository. A repo can keep its workflows under `.player-two/workflows/` as the place a person publishes them from.

**The hub has an identity.** It has its own key, made on first start, and the reserved name `hub`. `/info` reports its public key and clients pin it like a teammate's. What a workflow posts is a `message` with `via: "workflow"`, signed by the hub.

**Tags from a workflow count.** The rule becomes: a tag counts in a `message` written by a person, or by the hub with `via: "workflow"`. For grants and delegation, the asker of such a request is `workflow:<name>`, and a grant may list that form.

**The file.**

```yaml
name: ci-failure
on:
  webhook: {}                       # or  message: { contains: "P1" }
                                    #     reaction: { emoji: "🚀" }
                                    #     schedule: { cron: "0 9 * * 1-5", zone: "Europe/London" }
steps:
  - post: "The build failed on {{body.branch}}: {{body.url}}"
  - approve: { from: jacob, text: "Ask the uploader agent what broke?" }
  - tag: "@jacob/uploader"
    text: "The build at {{body.url}} failed. What broke?"
  - webhook: { url: "https://ci.corp.internal/retry", body: '{"build": "{{body.id}}"}' }
    if: { equals: ["{{body.retry}}", "true"] }
```

| Part | Meaning |
|---|---|
| `on.webhook` | `POST /hooks/{id}` starts a run. `id` is the first 32 hex of the defining event's id. An optional `secret` must match the `X-Player-Two-Secret` header. |
| `on.message` | A person's message in the channel whose text contains the words. The hub's own messages never trigger anything. |
| `on.reaction` | That emoji added to any message in the channel. |
| `on.schedule` | A cron line, in the named time zone. Runs missed while the hub was down are not made up. |
| `post` | The hub posts a message. |
| `tag` | The hub posts a message that tags an agent. The job waits for its owner or a grant. |
| `approve` | The hub posts the text and waits for a 👍 from the named person, or from any member with `from: anyone`. Default limit 24 hours, set with `within`. |
| `webhook` | The hub calls an address. Allowed only for hosts listed in `PLAYER_TWO_WEBHOOK_ALLOW`. |
| `if` | `equals` or `contains` over two templated strings. Nothing more. |

Templates are `{{trigger.text}}`, `{{trigger.author}}`, `{{body.path.to.field}}` for a webhook's JSON, filled in one pass; an unknown name is left as written. There is no expression language.

**Limits.** 20 workflows per channel, 20 steps each, 30 runs per workflow per hour, 50 runs waiting at once. Past a limit, the run is recorded as throttled and does nothing.

## A. The hub's identity

- [x] **P7-A1** The hub makes an Ed25519 key on first start and keeps it in a `meta` table (schema version 8). `POST /join` refuses the name `hub`. `/info` gains `hubKey`.
- [ ] **P7-A2** Clients pin `hubKey` the first time they see it, in `known.json` under `hub`, and check the hub's events against it. `src/core/chat.ts` counts tags in a hub message with `via: "workflow"`. `liveGrant` and `peopleInvolved` use `workflow:<name>` as the asker.
- [ ] **P7-A3** Tests: an event claiming the author `hub` with another key is untrusted; a tag in a hub workflow message creates a waiting job; the same text from the hub without `via: "workflow"` does not.

## B. Definitions

Add `yaml` and `croner` as dependencies.

- [ ] **P7-B1** `workflow.define { name, yaml }` and `workflow.remove { name }` in `src/core/kinds.ts`, and `workflow.run` for the hub. Add them to the kinds table in [`protocol.md`](protocol.md).
- [x] **P7-B2** `src/core/workflow.ts`, pure: parse the YAML into a typed definition with a zod schema that rejects unknown keys and says which line is wrong; `fill(template, values)`; `holds(condition, values)`. Tests for each trigger and step, for a bad file's message, and for templates.
- [ ] **P7-B3** `workflow.define` and `workflow.remove` are structural: the author must be a member of the channel; the YAML must parse; the per-channel limit must hold. A definition with the same name replaces the earlier one. The hub keeps live definitions in a `workflows` table.
- [ ] **P7-B4** `player-two workflow publish FILE --in CHANNEL`, `player-two workflow list --in CHANNEL`, `player-two workflow remove NAME --in CHANNEL`, each with `--json`.

## C. Running

- [ ] **P7-C1** `src/hub/workflows.ts`: a run is a row in `workflow_runs` with its definition's event id, its trigger values, the index of the step it is at, and its state. Steps run one at a time. After each step the hub publishes a `workflow.run` event to the channel with the step and its outcome, and saves the row.
- [ ] **P7-C2** Triggers: the message and reaction triggers are checked as each event is stored; schedules use `croner`; `POST /hooks/{id}` takes a JSON body of at most 256 KB, checks the secret with a constant-time comparison, and answers `202` at once. An unknown id answers `404`.
- [ ] **P7-C3** `post` and `tag` publish the hub's messages. `tag` refers to nothing the hub runs: it ends as soon as the message is stored.
- [ ] **P7-C4** `approve` posts its message, records the message's id on the run, and sets the run waiting. A 👍 `reaction` on that message from the right person moves the run on. When the hub starts, it reloads waiting runs, so a restart loses nothing. A run past its limit ends as expired.
- [ ] **P7-C5** `webhook`: refused unless the address's host ends with an entry in `PLAYER_TWO_WEBHOOK_ALLOW` and its scheme is `https`, or `http` for a host on that list. No redirects, ten seconds, at most 1 MB read back, and the response is not put into the chat. With the variable unset, every webhook step is refused: the hub sits inside the cluster and must not be usable to reach what is around it.
- [ ] **P7-C6** The limits above, each recorded as a throttled `workflow.run`.
- [ ] **P7-C7** `test/workflows.test.ts` against the in-process hub with a fixed clock: each trigger starts a run; `post` and `tag` appear in the channel; a tag from a workflow waits for its owner and runs under a grant that lists `workflow:<name>`; `approve` waits, survives stopping and starting the hub on the same database, moves on at the right person's 👍 and ignores anyone else's; a webhook step to a host not on the list is refused; the hourly limit throttles; the hub's own message does not trigger a message workflow.

## D. The window

- [ ] **P7-D1** A "Workflows" panel on a channel: each definition with its name, trigger in words, who published it and when; its recent runs from `workflow.run` events with each step's outcome; "Remove". For a webhook workflow, the address to call, with a copy button.
- [ ] **P7-D2** "Publish a workflow": pick a file from `.player-two/workflows/` in a checkout of the channel's pinned repo, see it parsed back in words, confirm. A file that does not parse shows the line and the reason.
- [ ] **P7-D3** A run waiting on my approval is marked in the chat list like a request waiting for my agent, and its message has a "👍 Approve" button that sends the reaction.
- [ ] **P7-D4** The hub's messages are drawn as from "workflow: ci-failure", distinct from people and from agents.

## Done when

1. Every task is ticked and the checks are green.
2. In a scenario test, a `POST` to a workflow's hook posts to the branch's room and tags the owner's agent; the job runs after the owner's approval, or at once under a grant for `workflow:ci-failure`; the answer is posted.
3. The README documents the file format, the limits, who can publish, that anyone in a channel can read a workflow's secret, and `PLAYER_TWO_WEBHOOK_ALLOW`.

## Notes

- **P7-B2: what the parser reads, what it decides, and what it leaves to the hub.** `src/core/workflow.ts` exports `parseWorkflow(source): Workflow`, `fill(template, values)`, `holds(condition, values)` and the types `Workflow`, `Trigger`, `Step`, `Condition` and `Values`. A file that does not read throws an `Error` saying `line N: path: reason`, such as `line 7: steps.2.text: required`; the hub's 422 and the window's publish dialog can show it as it is. Tested in `test/workflow.test.ts`.
  - The shape. The trigger, each step and each condition carry `kind`, the key they were written with, beside that key's fields as written: `{ kind: "tag", tag: "@jacob/uploader", text, if? }`, `{ kind: "schedule", schedule: { cron, zone } }`. Setting `kind` before the schema reads the object is what lets a mistake inside a step be reported against the step meant, where a zod union reports every option it tried; a `kind` written in the file is refused as an unknown key. A step or trigger with none of its keys, or two, is "a step has exactly one of post, tag, approve, webhook" at its line. An unknown key is reported at its own line, a missing one at the line of the object it is missing from.
  - Decided here. `name` is a name like a person's (`[a-z0-9][a-z0-9_-]{0,31}`), since grants list `workflow:<name>`; P7-B3 should refuse a `workflow.define` whose `name` is not its file's. A workflow has one to 20 steps. `message.contains` and a webhook's `secret` cannot be empty (an empty secret would match a request with no header), and `reaction.emoji` is at most 32 characters, as a reaction's is. `schedule` needs both `cron` and `zone`, so the hub's own zone never matters. `cron` is five fields, as croner's own parser reads them in `mode: "5-part"` (so `@daily` and `MON-FRI` are fine, and the error is croner's words); P7-C2 must schedule with that mode too, or a six-field line would mean seconds. `zone` is whatever `Intl.DateTimeFormat` takes, which is what croner hands it to. `tag` is a literal `@owner/repo`, lowercase, and needs `text`; `approve.from` is a literal name, `anyone` meaning any member, so a person named "anyone" cannot be singled out. `within` is a number of minutes, hours or days written `90m`, `12h` or `2d` (up to 9999), read into seconds, and 86,400 when left out. A webhook step's `url` must be an `https` or `http` address as written, and its `body` is an optional string.
  - Templates. Every other string a step holds is a template: `post`, a tag's `text`, an approval's `text`, a webhook's `url` and `body`, and both sides of an `if`; nothing checks the names in them. `fill` looks a name up through objects and lists by their own keys only (`{{body.commits.0.id}}`, never `{{body.constructor}}`), ignoring spaces inside the braces; a name that reaches a string, a number or true/false is filled in, and any other, an object or null included, is left as written. `holds` compares exactly: `equals` is the same string, `contains` is case-sensitive. Two things for P7-C5: nothing is escaped, so a value filled into a webhook's JSON `body` can change its shape; and a template may stand where the host is (`https://{{body.host}}/retry` is a valid address as written), so the allow list must be checked against the address after it is filled.
  - YAML. Read with `yaml`'s default YAML 1.2 core schema, so `on:` is a key and not `true`. A syntax error, a repeated key among them, is yaml's own words at its line. Aliases are expanded within yaml's limit of 100, past which the file is refused at line 1 as yaml words it. `yaml` 2.9.1 and `croner` 10.0.1 are added as the section says; croner is used here only to read the cron line.
- **P7-A1: where the key is, what the name `hub` may and may not do, and bringing schema 7 forward.** The key is made by `Database.hubKey()` in `src/hub/db.ts` (an `INSERT OR IGNORE` into `meta` under `hub_key`, the private half in hex, then read back), which `createHub` asks once as it starts, so it is made on the first start and the same on every start after; `/info` gives its public half as `hubKey`, which `hubInfoSchema` reads as optional, as a hub before this sends none. The name is `HUB` in `src/core/wire.ts`. `POST /join` refuses it with `409 the name 'hub' is the hub's own`; `workflow:<name>` was already no person's name, as `:` is not in one. The hub is not in `users`, so nobody can sign a header or post an event as `hub`, the hub's own key included (`401`): section C stores what the hub signs straight into the log, inside a transaction, as `storedUnchecked` in `test/startHub.ts` does now. `hub verify` checks an event authored `hub` against the key in `meta`, saying `its signature does not hold under the hub's own key` for any other. Schema 8 is schema 7 and the `meta` table; a database of schema 5, 6 or 7 is brought forward, unless someone joined in it as `hub`, which is refused with words saying so (their events would read as the hub's), as the plan leaves an older user of the name open. `SCHEMA_VERSION` and `HUB_FROM` in `src/hub/db.ts` are the numbers to change if another task takes 8 first; the test of bringing 7 forward names its version once, `BEFORE`, and the others read `SCHEMA_VERSION`, now exported.
