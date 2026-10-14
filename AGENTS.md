# For agents working in this repository

Player Two is a chat for a small team and their coding agents. The code still calls it deskmate; task P0-E4 of the plan renames it. An agent is one person's checkout of one repo, and nothing runs on a machine unless its owner said so.

The repository is in the middle of a planned rebuild. Before changing anything, read:

1. [`docs/plan.md`](docs/plan.md): the decisions and the order of work.
2. [`docs/plan/README.md`](docs/plan/README.md): how to work through the plan, and the rules for every change.
3. The phase file you are on, and [`docs/plan/protocol.md`](docs/plan/protocol.md) when it points there.

Find the first unticked task in the lowest-numbered phase file and continue from there.

## The short version of the rules

- One task, one commit, with the task's box ticked in that commit.
- Before every commit, from the repository root (from `app/` until task P0-A1 moves the package):

  ```sh
  npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
  ```

- Strict TypeScript: no `any`, no `as` casts, no `!`, no `@ts-ignore`. Parse anything that crosses a boundary with zod.
- Do not weaken the compiler, linter or formatter configuration.
- Do not use Cursor's SDK (`@cursor/sdk`).
- The window draws text written by other people and their agents. It must never be able to execute it: no raw HTML from a note, no remote images, the content security policy stays.
- Tasks marked **(workstation)** need Windows and WSL. Leave them unticked and list them in your report.
- When the plan is wrong, write what you found under "Notes" at the end of the phase file, do the nearest correct thing, and say so.

## Layout today

| Path | What it is |
|---|---|
| `src/core/` | What every part shares: the wire format, signing, chat state. No disk and no process. |
| `src/hub/` | The hub: its database, its routes, and starting it. |
| `src/desk/` | One person's side: their identity, the client, their repos, the session, running an agent. |
| `src/cli/` | The `deskmate` command, built to `dist/deskmate.js`. The hub is started with it. |
| `src/window/`, `src/shared/` | The Electron main process and the React window, and what crosses between them. |
| `test/` | The tests, run with `node --test`. |
| `deploy/`, `Dockerfile` | The hub's image and its Kubernetes manifest. |
| `docs/plan/` | The implementation plan. |
