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

- [ ] **P7-A1** The hub makes an Ed25519 key on first start and keeps it in a `meta` table (schema version 8). `POST /join` refuses the name `hub`. `/info` gains `hubKey`.
- [ ] **P7-A2** Clients pin `hubKey` the first time they see it, in `known.json` under `hub`, and check the hub's events against it. `src/core/chat.ts` counts tags in a hub message with `via: "workflow"`. `liveGrant` and `peopleInvolved` use `workflow:<name>` as the asker.
- [ ] **P7-A3** Tests: an event claiming the author `hub` with another key is untrusted; a tag in a hub workflow message creates a waiting job; the same text from the hub without `via: "workflow"` does not.

## B. Definitions

Add `yaml` and `croner` as dependencies.

- [ ] **P7-B1** `workflow.define { name, yaml }` and `workflow.remove { name }` in `src/core/kinds.ts`, and `workflow.run` for the hub. Add them to the kinds table in [`protocol.md`](protocol.md).
- [ ] **P7-B2** `src/core/workflow.ts`, pure: parse the YAML into a typed definition with a zod schema that rejects unknown keys and says which line is wrong; `fill(template, values)`; `holds(condition, values)`. Tests for each trigger and step, for a bad file's message, and for templates.
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
