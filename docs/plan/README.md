# How to build from this plan

This folder is the implementation plan for deskmate. It is written for a coding agent working through it on a Linux server, with a person checking in between phases. [`../plan.md`](../plan.md) is the one-page overview and holds the decisions; the files here hold the work.

## The files

| File | What it is |
|---|---|
| [`protocol.md`](protocol.md) | Reference: the event envelope, the kinds, the hub's API, the desk's protocol, permission modes. The phase files point here instead of repeating it. |
| [`phase-0-one-language.md`](phase-0-one-language.md) | Node hub, TypeScript command, desk and window split, WSL, setup check, shadcn, packaging. Python deleted. |
| [`phase-1-event-log.md`](phase-1-event-log.md) | One signed event log; jobs; threads, reactions, edits; paging. |
| [`phase-2-search-cli-mcp.md`](phase-2-search-cli-mcp.md) | Search, note links, `deskmate ask`, and an MCP server for outside agents. |
| [`phase-3-acp-permissions.md`](phase-3-acp-permissions.md) | Agents over ACP, permission modes, the live activity feed. |
| [`phase-4-agent-keys-grants.md`](phase-4-agent-keys-grants.md) | Agent keys and standing grants. |
| [`phase-5-delegation.md`](phase-5-delegation.md) | Agents asking agents, gated at every hop. |
| [`phase-6-branch-rooms-azure-devops.md`](phase-6-branch-rooms-azure-devops.md) | Branch rooms, patches, Azure DevOps pull requests and builds. |
| [`phase-7-workflows.md`](phase-7-workflows.md) | YAML automation on the hub. |
| [`workstation-checklist.md`](workstation-checklist.md) | What only a Windows workstation can prove. For the person, not the agent. |

## Order

Do the phases in order. Inside a phase, do the sections in order: each leaves the checks green for the next. Phases 4 to 7 each depend on the ones before them as their first lines say.

A phase is finished when every task is ticked and its "Done when" holds. Then stop and report; do not start the next phase in the same sitting unless told to.

## Working rules

1. **One task, one commit.** Tick the task's box in the same commit. Write commit subjects the way the history does: a plain sentence saying what changed, no prefix.
2. **Green before every commit.** Run, from the repository root (from `app/` until task P0-A1 moves it):

   ```sh
   npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
   ```

   Zero warnings. Do not weaken `tsconfig.json`, `eslint.config.mjs` or `prettier.config.mjs` to get there, and do not add `any`, `as` casts, `!` or `@ts-ignore`. Parse anything that crosses a boundary with a zod schema and derive the type from it.
3. **Match the code that is there.** Comments say why, in plain words, at about the density the existing files have. Read `src/core/session.ts` before writing anything like it.
4. **Smallest thing that satisfies the task.** No frameworks the task does not name, no abstraction with one use, no configuration for a value that never changes. A new dependency needs a task that names it.
5. **Each piece of logic leaves one test behind.** Tests run with `node --test` and import the `.ts` sources directly. Prefer one scenario test against a real in-process hub over many mocked unit tests.
6. **Never weaken what deskmate protects.** Nothing runs on a machine unless its owner said so. The window draws text from other people and their agents and must stay unable to execute it. If a task seems to need either rule bent, stop and ask.
7. **Do not use Cursor's SDK** (`@cursor/sdk`). It does not work behind the team's proxy. Cursor is driven only through its command line.
8. **When the plan is wrong, say so.** If a task cannot be done as written, or a fact in it turns out false, write what you found under a "Notes" heading at the end of that phase file, do the nearest correct thing, and carry on. Do not silently do something else.

## What cannot be checked on the server

The server is Linux without a display. The hub, the desk, the command and the MCP server are all fully testable there. Three things are not:

- **The window on Windows, and WSL.** Code for these is written and unit-tested against recorded `wsl.exe` output; the real run is in [`workstation-checklist.md`](workstation-checklist.md).
- **Cursor and Copilot.** Neither is installed on the server. Phase 3 is tested against a scripted ACP agent in `test/fixtures`.
- **The window's look.** The smoke test in task P0-J6 runs under `xvfb-run` in CI. Locally, skip it when there is no display.

Tasks that need a workstation are marked **(workstation)**. Leave them unticked, list them in your report, and do not let them hold up the rest.

## Environment

- Node 26 and npm. A user-local install is fine; nothing needs root.
- `git` on the `PATH`.
- `uv`, only until task P0-E1 deletes the Python code.
- No network access is needed by the tests. Building the Linux runtime archive (task P0-H1) downloads Node from nodejs.org.
