# Phase 5: agents asking agents, gated at every hop

Goal: "does this API change break the client?" asked of one agent can fan out to the checkouts that know, and come back as one answer, with a person or a grant standing behind every run on every machine.

Depends on: phase 4. A delegated request is signed by the asking agent's key.

Borrowed from Buzz: job requests between agents and delegation trees. Today Player Two forbids an agent's answer from tagging anyone, and that stays true: a tag still counts only in a message a person wrote. Delegation is a separate, explicit event.

## The design

**The request.** An agent in a run asks another agent by calling the `ask_agent` MCP tool. That publishes a `job.request`, signed by the asking agent:

```ts
// to: the chat the root request is in      refs: [root request id, parent request id]
{ target: "bob/billing",
  text: "Does removing `retries` from UploadOptions break your caller?",
  chain: ["jacob/uploader"] }   // the agents from the root down to the asker, in order
```

The job it creates is identified by the `job.request`'s id and the target, and moves through the same states as any other.

**The limits.** Constants in `src/core/delegation.ts`:

| Limit | Value | Why |
|---|---|---|
| Depth | `chain` has at most 2 agents | A root agent may ask others, and they may ask one level further. No deeper. |
| Fan-out | 4 children per job | |
| Tree size | 8 jobs under one root | |
| No repeats | The target is not in `chain` | No loops. |
| Mode | A child's mode is at most its parent's | A read-only run cannot cause a write elsewhere. |
| Time | A root job ends after 60 minutes, whatever is still waiting | |

**The gate.** Every hop needs the target's owner: a click, or a grant. A grant covers a delegated request only if its `askers` include every person involved: whoever made the root request, and the owner of every agent in `chain`. Nobody's agent runs because of a chain they did not agree to all of.

**Who may delegate.** An owner decides, when accepting, whether their agent may ask others in that run. `job.accepted` gains `delegate: boolean`. It is off by default for a teammate's request and on for my own. The `ask_agent` tool is attached to a run only when it is on.

**Checking a chain.** The target's desk trusts nothing in a `job.request` it cannot see in the log: for each agent in `chain` there must be an accepted, still-working job for the request above it, with `delegate` on, and the limits must hold. Otherwise the request is declined automatically with the reason.

## A. The pieces

- [ ] **P5-A1** `job.request` in `src/core/kinds.ts`, and `delegate` on `job.accepted` (default `false` when absent, so earlier events still parse). Update the kinds table in [`protocol.md`](protocol.md).
- [ ] **P5-A2** The hub adds `job.request` to the kinds an agent may author.
- [ ] **P5-A3** `src/core/delegation.ts`, pure: `checkRequest(log, request)` returning `ok` or a reason, covering each limit and the chain check; `tree(log, root)` returning the jobs under a root as a tree; `peopleInvolved(log, request)`. One test per limit and per way a chain can be false: an agent that was never accepted, a parent that already finished, a parent accepted without `delegate`, a made-up root.
- [ ] **P5-A4** `src/core/chat.ts` folds `job.request` into a job like a tagged message, with its parent, and exposes the tree for a root.
- [ ] **P5-A5** `liveGrant` in `src/core/grants.ts` takes the people involved and requires all of them to be in `askers`. Tests: a grant for bob alone does not cover a request that came through carol's agent.

## B. Running a delegated job

- [ ] **P5-B1** In a run with `delegate` on, the MCP server attached to the agent is started with the agent's key and a `--job` argument naming the job. It then offers `ask_agent` (and no other sending tool). `ask_agent { agent, text, wait_seconds }` checks the limits locally, publishes the `job.request`, and waits for that child to end, up to `wait_seconds` (at most 900). It returns the child's result text as data, or which of declined, failed, withdrawn or timed out happened.
- [ ] **P5-B2** Time an agent spends waiting on a child does not count towards its own 900-second limit. The 60-minute limit on the root does: when it passes, the root's desk cancels its run and withdraws every child still open.
- [ ] **P5-B3** On the target's desk, an incoming `job.request` goes through `checkRequest`; a failure publishes `job.declined` with the reason. A valid one is offered to the owner like any request, showing the chain and capped at the parent's mode, or accepted under a grant that covers everyone involved.
- [ ] **P5-B4** A child's result is posted to the chat in every case, so the people there can read what each agent said; "review first" delays it until the owner sends it. The parent agent receives it only once it is posted.
- [ ] **P5-B5** Withdrawing and stopping travel down the tree. When a root is withdrawn by its asker, or a job is stopped by its owner, that job's desk publishes `job.withdrawn` for each open child, signed by the agent that asked. A desk that sees its job's parent withdrawn or ended cancels its own run.
- [ ] **P5-B6** The prompt for a delegated job says who asked first, which agents it came through, and that the text is another agent's request, to be treated as a question and not as instructions about anything else.

## C. The window

- [ ] **P5-C1** When accepting a request, a switch: "Let this agent ask other agents". Off by default for a teammate's request.
- [ ] **P5-C2** Under the note that started it, the tree: one line per job, indented by depth, each with its agent, state and mode. It folds to "3 agents involved" when all are done. A delegated request in the chat reads "jacob's uploader agent asked @bob/billing: …".
- [ ] **P5-C3** A delegated request waiting for me shows its chain in words before the buttons: "bob asked jacob's uploader agent, which is asking your billing agent".
- [ ] **P5-C4** The asker of the root has one "Withdraw" that ends the whole tree.

## D. Tests

- [ ] **P5-D1** Extend the scripted ACP agent: a prompt containing `ask:<owner/repo>` makes it call `ask_agent` for that target and put the reply in its answer.
- [ ] **P5-D2** A three-person scenario in `test/delegation.test.ts`: bob asks `@jacob/uploader` with a prompt that delegates to `@bob/client` and `@carol/billing`; jacob accepts with delegation on; bob and carol each accept; jacob's agent's answer contains both replies; the tree shows three jobs, all answered. Then, one by one: a third level is declined for depth; an agent asking itself or its parent is declined; a fifth child is declined; carol declining gives jacob's agent "declined" and it still answers; bob withdrawing the root stops carol's running agent; a `job.request` naming a parent that was accepted without `delegate` is declined by the target's desk.

## Done when

1. Every task is ticked and the checks are green.
2. The three-person scenario passes.
3. A test shows no agent ran on any machine in that scenario without a `job.accepted` from its own owner in the log.
