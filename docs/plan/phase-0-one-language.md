# Phase 0: one language

Goal: Python leaves the repository, the project is renamed to Player Two, nothing a user can do today is lost, and the app is in the shape every later phase builds on: a hub, a desk, a window and a command, all TypeScript, with the desk able to run inside WSL.

The code is called deskmate until task P0-E4 renames it. Sections A to E below use the old name; everything after uses the new one.

Read first: [`README.md`](README.md) for the working rules, and [`protocol.md`](protocol.md) for the pieces, the auth header and the desk's protocol.

## Where things stand

| Path | What it is | Fate |
|---|---|---|
| `src/deskmate/hub.py` | The hub: FastAPI, SQLite, long-polling. 302 lines. | Ported in section B, deleted in E. It is the specification for the port. |
| `src/deskmate/cli.py` | The `deskmate` command. | Ported in section D, deleted in E. |
| `src/deskmate/tui.py`, `widgets.py` | The terminal interface. | Deleted in E. The window replaces it. |
| `src/deskmate/wire.py`, `client.py`, `chat.py`, `repos.py` | The Python client. | Deleted in E. Already ported to `app/src/core`. |
| `tests/` | Python tests. `test_hub.py` and `test_cli.py` list the behaviour to keep. | Cases ported in B and D, then deleted in E. |
| `app/src/core/` | TypeScript client: `wire`, `sign`, `text`, `repos`, `client`, `chat`, `session`. | Kept, moved in A. |
| `app/src/main/`, `app/src/renderer/` | Electron main process and preload; React window. | Kept, moved in A, split in F, restyled in J. |
| `app/src/shared/ipc.ts` | The view the window draws and the commands it sends, as zod schemas. | Becomes the desk's protocol in F. |
| `app/test/hub.test.ts` | Two sessions against the real hub, end to end. | The acceptance test for the hub port. |

## A. Reshape the repository

No behaviour changes in this section. The Python hub stays and the tests keep running against it.

- [x] **P0-A1** Move the package to the repository root with `git mv`: `app/package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `prettier.config.mjs`, `build.mjs`, `.prettierignore`. Fold `app/.gitignore` into the root `.gitignore`. Move `app/test` to `test`. Remove the empty `app/`.
- [x] **P0-A2** Move the sources to their homes. Fix every import.

  | From | To |
  |---|---|
  | `app/src/core/{wire,sign,text,chat}.ts` | `src/core/` (pure; no `node:fs`, no process) |
  | `app/src/core/{client,repos,session}.ts` | `src/desk/` |
  | `runAgent` and `splitCommand` in `client.ts` | `src/desk/agents/oneshot.ts` |
  | `app/src/shared/ipc.ts` | `src/shared/ipc.ts` |
  | `app/src/main/` | `src/window/main/` |
  | `app/src/renderer/` | `src/window/renderer/` |

- [x] **P0-A3** In `package.json`: name `deskmate`, `"engines": { "node": ">=26" }`. Add `.nvmrc` with `26`. Point `build.mjs` and `tsconfig.json` at the new paths.
- [ ] **P0-A4** `test/hub.test.ts` finds the Python project one folder up from `test`, not two. All checks green, with the scenario test still passing against the Python hub.

## B. The hub in Node

Port `src/deskmate/hub.py` route for route. Same paths, same status codes, same `detail` strings, same SQLite schema. Read it fully before starting.

Shape:

| File | Holds |
|---|---|
| `src/hub/db.ts` | Opening the database with `node:sqlite` (`DatabaseSync`), the schema, the version check, one function per query. |
| `src/hub/app.ts` | `createHub(settings, now)` returning a `node:http` server. A small table of routes; no web framework. |
| `src/hub/main.ts` | Reads settings from the environment with a zod schema, starts the server, logs `key=value` lines. |

- [ ] **P0-B1** `db.ts`. The schema from `hub.py`, `PRAGMA journal_mode = WAL`, and the refusal to open a database whose `user_version` is not this version's. Check `node:sqlite` loads without a warning on Node 26; if it warns, say so in Notes and use `better-sqlite3`.
- [ ] **P0-B2** `app.ts`: `GET /healthz`, `POST /join`, `GET /info`, `GET /users`, and the `caller` check on the `Authorization` header that also records when the caller was last seen. Bodies and parameters are parsed with the schemas in `src/core/wire.ts`. A failed parse answers `422` with a `detail` naming the field.
- [ ] **P0-B3** `PUT /repos` and `GET /repos`, with the "under the hub's `DESKMATE_REPOS`" rule. That rule is `prefixKey` and `isUnder` in `src/desk/repos.ts`; move the half of that file that only parses text (`parseRemote`, `prefixKey`, `isUnder` and what they call) to `src/core/remotes.ts`, so the hub can import it without the half that reads the disk.
- [ ] **P0-B4** `POST /notes`: signature, freshness, the `UNIQUE` signature as replay protection, membership for a channel, existence for a person.
- [ ] **P0-B5** `GET /notes` with `after`, `tail`, `mine`, `status` and `wait`. The wait is a promise that resolves when a note arrives or the time is up; no thread is held. Cap `wait` at 30 seconds as today.
- [ ] **P0-B6** The channel routes: list, join, leave, pin, unpin.
- [ ] **P0-B7** `main.ts`: `DESKMATE_JOIN_TOKEN` (at least 16 characters), `DESKMATE_DB`, `DESKMATE_REPOS`, all required; `--host` (default `127.0.0.1`) and `--port` (default `8787`). Refuse to start with a clear message when one is missing. Stop cleanly on `SIGTERM` within three seconds.
- [ ] **P0-B8** `test/hub.api.test.ts`: port every case in `tests/test_hub.py` except the installer one (section H replaces it). Start the server in-process on port 0 with a fixed clock. Keep the Python tests' names as the test titles.
- [ ] **P0-B9** `test/hub.test.ts` starts the Node hub in-process instead of spawning `uv`. It must pass without changing a single expectation.

## C. Protocol 1: what the review found

These change the wire, so the Python client stops working here. That is expected.

- [ ] **P0-C1** `GET /info` returns `{ version, protocol: 1, repos, now }`. `version` comes from `package.json` at build time.
- [ ] **P0-C2** In `src/desk/client.ts`, parse the hub's responses with schemas that ignore unknown keys: `z.object`, not `z.strictObject`, for `HubInfo`, `Person`, `ChannelInfo`, `TeamRepo`, `Delivered`, `Receipt`. The note inside `Delivered` stays strict. Say why in a comment beside them: these may gain fields, and a signed note may not.
- [ ] **P0-C3** Auth header version 2, as in [`protocol.md`](protocol.md): the signed text includes the method and the path with its query. `src/core/sign.ts` builds it; the hub verifies against the request it actually received. Add a vector to `test/fixtures` and a test that a header for `GET /users` is refused on `POST /channels/x/join`.
- [ ] **P0-C4** The desk compares `/info`'s `protocol` with its own when it connects. On a mismatch the link state is `down` with a problem that names which side to update, and it does not retry in a loop: it asks again once a minute.
- [ ] **P0-C5** Set the version to `0.4.0` in `package.json`.

## D. The command in TypeScript

One program with subcommands, built to one file, `dist/deskmate.js`. It is what the Docker image runs as the hub, what agents call, and what the window starts as the desk.

- [ ] **P0-D1** `src/cli/main.ts` with `node:util`'s `parseArgs`: `join`, `send`, `inbox`, `who`, `repos`, `channel [list|join|leave]`, `hub`, with the arguments and the wording of the README's Commands table. `send TEXT` of `-` reads standard input. `--wait` behaves as documented.
- [ ] **P0-D2** Exit codes as documented: `0`, `1` after a message on standard error, `2` for a usage error.
- [ ] **P0-D3** Every reading command takes `--json` and then prints one JSON value and nothing else: `inbox` and `send --wait` print notes as the hub delivered them plus `trusted`; `who`, `repos` and `channel` print arrays.
- [ ] **P0-D4** `test/cli.test.ts`: port the cases in `tests/test_cli.py` (drop the two about the terminal interface), calling `main(argv, { home, transport })` in-process against the in-process hub.
- [ ] **P0-D5** `build.mjs` bundles `src/cli/main.ts` to `dist/deskmate.js` with a `#!/usr/bin/env node` line, and `package.json` gets `"bin": { "deskmate": "dist/deskmate.js" }`.

## E. Delete Python

Only when sections A to D are ticked and green.

- [ ] **P0-E1** Delete `src/deskmate/`, `tests/`, `pyproject.toml`, `uv.lock`, `.python-version`, `.pre-commit-config.yaml`. Remove the Python lines from `.gitignore` and `.dockerignore`.
- [ ] **P0-E2** Rename `test/fixtures/python-vectors.json` to `signing-vectors.json`. In `test/vectors.test.ts`, change the header comment: the file is now the frozen record of the signing format, kept so a change to what is signed cannot happen by accident.
- [ ] **P0-E3** `grep -ri "python\|uv run\|pytest\|textual" --exclude-dir=node_modules --exclude-dir=docs .` finds nothing outside the README, which section K rewrites.

### The rename

The project is renamed from deskmate to Player Two. It happens here, once Python is gone, so no dead code is renamed and the wire strings change in one step with nothing else speaking the old ones. Nobody has an identity on a real hub yet, so nothing is migrated.

- [ ] **P0-E4** Rename everything that is left, in one commit:

  | What | From | To |
  |---|---|---|
  | The name people read | deskmate | Player Two |
  | Package, command, built file | `deskmate`, `dist/deskmate.js` | `player-two`, `dist/player-two.js` |
  | Environment variables | `DESKMATE_JOIN_TOKEN`, `DESKMATE_DB`, `DESKMATE_REPOS`, `DESKMATE_HOME`, `DESKMATE_DEV` | `PLAYER_TWO_JOIN_TOKEN`, and so on |
  | Identity folder | `~/.config/deskmate` | `~/.config/player-two` |
  | Signed prefixes | `deskmate-note-v3`, `deskmate-auth-v2` | `player-two-note-v3`, `player-two-auth-v2` |
  | Auth header scheme | `Deskmate` | `PlayerTwo` |
  | Class and type names | `DeskmateError` | `PlayerTwoError` |
  | Window title, product name | deskmate | Player Two |
  | Image, manifest names, labels, secret | `deskmate` | `player-two` |
  | `.env.example`, `Dockerfile`, `deploy/k8s.yaml`, `README.md` | | |

  Changing the signed prefixes changes every signature. Regenerate `test/fixtures/signing-vectors.json` in this commit, with a small script, `scripts/make-vectors.ts`, that writes what the TypeScript implementation produces for the same inputs. It is the one time a change to that file is the point.
- [ ] **P0-E5** `git grep -il deskmate` lists only `docs/ideas.md`, the files under `docs/plan/` and `AGENTS.md`, where the old name is history. Sections A to E of this file keep the old name on purpose: they describe the code as it was when they ran.

From here on, this plan uses only the new name.

## F. Split the desk from the window

Today the Electron main process holds the session (`src/window/main/main.ts` creates a `Session`). After this section it holds none of it: the desk does, as a separate process, speaking the protocol in [`protocol.md`](protocol.md).

- [ ] **P0-F1** In `src/shared/ipc.ts`, add schemas for every line in both directions, as two discriminated unions on `t`. Add `busy: { working, unsent }` to the chat view, so the window's quit warning needs no round trip. Add a `{ kind: "stopped", problem }` view for when the desk has gone.
- [ ] **P0-F2** `src/desk/main.ts`: `runDesk(input, output)`. It writes `hello`, then loads the identity from `defaultHome()`. With no identity it shows the `setup` view and accepts only the `join` command; after a join it starts the `Session`. It turns the session's hooks into `view`, `notice`, `arrival` and `ask` lines, and coalesces views to one per turn of the event loop as `main.ts` does now. A line that does not parse gets a `notice` and is otherwise ignored. When input ends it awaits `session.stop()` and returns.
- [ ] **P0-F3** `player-two desk` in `src/cli/main.ts` calls `runDesk(process.stdin, process.stdout)`. Nothing but protocol lines may reach standard output: route `console.log` to standard error at the top of that subcommand.
- [ ] **P0-F4** `src/window/main/deskProcess.ts`: starts the desk, splits its output into lines, matches replies to commands by `id`, and exposes `send(command)`, `answer(id, ok)`, `attend(flag)`, `stop()` and callbacks for the rest. It refuses a `hello` whose protocol it does not know. If the desk exits unasked, it restarts it up to three times with a growing delay, then shows the `stopped` view with the last lines of the desk's standard error.
- [ ] **P0-F5** On Linux and macOS, start the desk as `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and the arguments `dist/player-two.js desk`. This is also how development inside WSL runs. Section G adds Windows.
- [ ] **P0-F6** Rewrite `src/window/main/main.ts` around `deskProcess`: it keeps the window, the renderer's IPC, notifications, badge, title, the native dialogs that answer an `ask`, and the quit warning. It imports nothing from `src/desk/` except types.
- [ ] **P0-F7** `test/desk.test.ts`: start `runDesk` on two in-memory streams against the in-process hub with a temporary `PLAYER_TWO_HOME`. Drive it by lines only: `setup` view, `join`, a `chat` view, `send`, the note appears in a later view, a bad line gets a notice, ending input stops it. One more test spawns the built `dist/player-two.js desk` as a real process and checks `hello` arrives and that standard output holds only JSON lines.

## G. Windows and WSL

The window is a Windows program; the desk runs in the user's WSL distribution. None of this can run on the server, so the logic is written as pure functions over text and tested against recorded output, and the real thing is checked on a workstation.

Three lessons from T3 Code's WSL support, which does the same job:

- Call `wsl.exe` by its full path under `%WINDIR%\System32`. Never rely on `PATH`.
- Do not pass a script as an argument. `wsl.exe` re-escapes arguments and mangles quotes. Feed scripts to `sh -s` on standard input, and otherwise use `--exec` with plain arguments.
- Do not depend on Windows forwarding a loopback port into WSL. It can take thirty seconds or more to start. The desk's protocol is on standard input and output for this reason.

Tasks:

- [ ] **P0-G1** `src/window/main/wsl.ts`, pure parts first: `parseDistros(text)` for `wsl.exe --list --verbose` (run with `WSL_UTF8=1`; still strip NUL bytes, since older builds answer in UTF-16), returning each distribution's name, state, WSL version and whether it is the default; `explainFailure(code, stderr)` turning the common failures into words (WSL not installed, no distribution, distribution is WSL 1, distribution will not start). Unit tests over sample outputs in `test/fixtures/wsl/`.
- [ ] **P0-G2** The calls: `listDistros()`, `home(distro)` with `--exec printenv HOME`, `toLinuxPath(distro, windowsPath)` with `--exec wslpath -u` and forward slashes, and `runScript(distro, script)` with `--exec sh -s` and the script on standard input. Each has a timeout and returns a result, never throws.
- [ ] **P0-G3** `installScript(archivePath, digest)` returns the shell script that installs the runtime: check the archive's SHA-256 with `sha256sum`; if `~/.player-two/runtime/sha256-<digest>` is missing, unpack into a temporary folder beside it and rename; point `~/.player-two/current` at it with `ln -sfn`; link `~/.local/bin/player-two` to `~/.player-two/current/bin/player-two`; remove runtimes other than the current and the previous one. The script is idempotent and uses POSIX `sh` only. Test it on Linux by running it against a small fake archive in a temporary `HOME`.
- [ ] **P0-G4** On Windows, `deskProcess` starts the desk as `wsl.exe -d <distro> --exec <home>/.player-two/current/bin/player-two-desk`, after `installScript` has run for the archive in the app's resources. `player-two-desk` is a two-line launcher in the runtime (task P0-H1) whose first line is `#!/bin/bash -l`, so the desk gets the user's login environment without any quoting on the Windows side.
- [ ] **P0-G5** The desk works out the `PATH` an interactive shell would have, once at start: run `bash -lic` printing `PATH` between two markers, with a five-second limit, and fall back to its own `PATH`. Ubuntu's `.bashrc` returns early for non-interactive shells, so tools installed by `nvm` or `npm -g` are otherwise missing. Use that `PATH` for agents and for `git`. Put it in `src/desk/shellEnv.ts` with a test over sample output that has noise before and after the markers.
- [ ] **P0-G6** The window keeps the distribution's name in `settings.json` in Electron's user-data folder; with none saved it uses the default distribution. The setup page (section I) can change it, which restarts the desk.
- [ ] **P0-G7** **(workstation)** Everything in the "Phase 0" part of [`workstation-checklist.md`](workstation-checklist.md).

## H. Packaging, the hub image and CI

- [ ] **P0-H1** `scripts/build-runtime.mjs` builds the Linux runtime archive for `x64`: download the official Node 26 `linux-x64` tarball and check it against `SHASUMS256.txt`; lay out `bin/node`, `lib/player-two.js`, `bin/player-two` (a `sh` wrapper that runs `node --use-env-proxy --use-system-ca lib/player-two.js "$@"`, so requests honour `HTTPS_PROXY` and `NO_PROXY` and trust the certificates Ubuntu trusts, including an internal CA), and `bin/player-two-desk` (`#!/bin/bash -l`, then `exec` the wrapper with `desk`); write `dist/wsl-runtime.tar.gz` and `dist/wsl-runtime.tar.gz.sha256`.
- [ ] **P0-H2** Add `electron-builder` as a development dependency, with its configuration in `package.json`: an NSIS installer for Windows that carries `wsl-runtime.tar.gz` and its `.sha256` as extra resources; an AppImage for Linux that carries `dist/player-two.js`. `npm run package:win` and `npm run package:linux`.
- [ ] **P0-H3** A build-time variable, `PLAYER_TWO_HUB_URL`, bakes the hub's address into the window. When set, the join form shows it filled in and asks only for a name and the token.
- [ ] **P0-H4** The join form offers the agent as a choice, with these one-shot commands: Cursor, `agent -p --output-format text`; Copilot, `copilot -s --allow-all-tools --no-ask-user -p`; and "Other", a free field. The prompt is appended as the last argument, as now. Cursor is the default. Do not add Cursor's SDK.
- [ ] **P0-H5** The hub serves what a teammate needs to install, from a folder named by `PLAYER_TWO_DOWNLOADS` (optional; the routes answer `404` without it): `GET /downloads/{file}` for plain file names only, never a path; `GET /` a small page with the Windows installer link and the three install steps; `GET /install.sh` a script that fetches `wsl-runtime.tar.gz` from the same hub and runs the same install as P0-G3, for someone on Linux who wants only the command. The address the script embeds comes from the request, checked against the pattern `hub.py` used.
- [ ] **P0-H6** `Dockerfile`: `node:26-slim`, copy `dist/player-two.js`, `mkdir /data` owned by user `10001`, `ENV PLAYER_TWO_DB=/data/player-two.db`, `USER 10001`, `VOLUME /data`, `EXPOSE 8787`, `CMD ["node", "/app/player-two.js", "hub", "--host", "0.0.0.0", "--port", "8787"]`. Update `.dockerignore`. In `deploy/k8s.yaml` change only the image tag to `0.4.0`: the single replica, the `Recreate` strategy and the disk-backed volume stay. Add a comment that the volume must be an Azure Disk, not Azure Files.
- [ ] **P0-H7** `.github/workflows/ci.yml`: on every push, on `ubuntu-latest` with Node 26: `npm ci`, typecheck, lint, format check, test, build, then the window smoke test under `xvfb-run`.
- [ ] **P0-H8** `.github/workflows/release.yml`: on a tag `v*`, build the runtime archive on `ubuntu-latest`, pass it to a `windows-latest` job that runs `npm run package:win`, and attach the installer, the archive and its digest to the run. No signing step: the README says the team signs with its own certificate.

## I. The setup check

One list of checks, each with a plain result and the command that fixes it. Borrowed from T3 Code's welcome wizard. It never runs a fix itself.

```ts
interface Check {
  id: string;
  title: string; // "The hub answers"
  status: "ok" | "warn" | "fail" | "skip";
  detail: string; // what was found, in words
  fix: string; // a command or instruction to copy; "" when there is nothing to do
}
```

- [ ] **P0-I1** `src/desk/doctor.ts`: `runChecks(home, dev)` returning `Check[]`. Each check has a time limit and cannot throw. The checks, in order:

  | Id | Passes when | Fails or warns with |
  |---|---|---|
  | `node` | The runtime's Node is 26 or newer. | |
  | `identity` | `config.json` and `key` exist and parse; `key` is mode `0600`. | Fail: "not joined", or the `chmod` to run. |
  | `hub` | `GET /healthz` answers. | Fail, with the error. For a certificate error, the fix is the two commands that add the team's CA to Ubuntu. |
  | `proxy` | No proxy variable is set, or `NO_PROXY` covers the hub's host. | Warn: the hub is internal and a proxy is set without an exception for it. |
  | `protocol` | `/info`'s `protocol` equals this build's. | Fail: which side to update. |
  | `clock` | This clock and `/info`'s `now` differ by under 60 seconds. | Warn from 60; fail from 300, where signatures stop being accepted. |
  | `dev` | The repos folder exists. | Fail: the path it looked in, and `PLAYER_TWO_DEV`. |
  | `repos` | At least one folder there has an `origin` under the hub's repos address. | Warn: the address it wants, and one folder's `origin` as an example. |
  | `git` | `git --version` runs. | Fail. |
  | `git-auth` | `git ls-remote` of one team repo answers within 15 seconds with terminal prompts off. | Warn: credentials are not stored; the command to run by hand. |
  | `agent` | The configured agent's command is found on the resolved `PATH`. | Fail: what it looked for, and where the join form's choice is stored. |

- [ ] **P0-I2** `player-two doctor` prints the list as aligned text, and as JSON with `--json`. Exit `1` if any check failed.
- [ ] **P0-I3** A `doctor` command in `src/shared/ipc.ts`; the desk answers it with the checks in the reply's `data`. It works before joining, when it runs only the checks that need no identity.
- [ ] **P0-I4** On Windows the window adds its own checks ahead of the desk's: `wsl.exe` exists; the chosen distribution exists and is WSL 2; the runtime is installed and its digest matches; the desk said `hello`. When one of these fails there is no desk to ask, so the window shows these alone.
- [ ] **P0-I5** A "Setup" page in the window: the list, a copy button beside each `fix`, "Check again", and on Windows the distribution picker. It opens by itself when the desk cannot start or any check fails at launch, and from a "Setup" link beside the connection state.
- [ ] **P0-I6** `test/doctor.test.ts`: a healthy temporary home against the in-process hub is all `ok`; a hub clock 400 seconds ahead fails `clock`; a missing key fails `identity`; an unreachable hub fails `hub` and skips the checks that need it.

## J. shadcn/ui

The window's look moves from one hand-written stylesheet to Tailwind and shadcn/ui. Behaviour does not change.

- [ ] **P0-J1** Build the renderer with Vite: add `vite`, `@vitejs/plugin-react`, `tailwindcss` and `@tailwindcss/vite` as development dependencies; `vite.config.ts` with root `src/window/renderer`, `base: "./"`, output `dist/renderer`, and the alias `@` for the renderer folder. `build.mjs` keeps bundling the command, the Electron main process and the preload with esbuild, and calls Vite for the renderer. Add the alias to `tsconfig.json`.
- [ ] **P0-J2** Initialise shadcn/ui into `src/window/renderer/components/ui` and add: `button`, `input`, `textarea`, `label`, `badge`, `dialog`, `command`, `popover`, `scroll-area`, `tooltip`, `sonner`, `resizable`, `dropdown-menu`, `separator`. These files are vendored: exclude that one folder in `eslint.config.mjs` with a comment saying so, keep them under `tsc`, and fix what the strict compiler options reject in place.
- [ ] **P0-J3** Theme: shadcn's CSS variables in one `globals.css`, light and dark following the system setting. Agent messages keep a coloured left edge and tags keep their accent colour.
- [ ] **P0-J4** Replace, one component per commit, keeping each one's behaviour and keyboard handling:

  | Today | Becomes |
  |---|---|
  | The native `<dialog>` in `dialogs.tsx` | `Dialog` |
  | The tag list in `Composer.tsx` | `Command` inside a `Popover`, anchored to the message box |
  | Toasts in `App.tsx` | `Sonner` |
  | Thread and chat-list scrolling | `ScrollArea`; the thread still pins to the newest note |
  | The chat list's fixed width | `Resizable` panels, the width remembered in `localStorage` |
  | Buttons, inputs, the join form | `Button`, `Input`, `Label`, `Textarea` |
  | Unread counts and marks | `Badge`, with a `Tooltip` saying what each mark means |
  | The time on a note | A `Tooltip` with the full date |

- [ ] **P0-J5** Delete `styles.css`. Keep the content security policy in `index.html` as it is. Check that popovers, dialogs and toasts position correctly under it. If they do not because inline style attributes are blocked, add `style-src-attr 'unsafe-inline'` and nothing wider: scripts and `<style>` elements stay locked to the app's own files.
- [ ] **P0-J6** `test/window.smoke.ts`: start the in-process hub and one more identity; launch Electron with a temporary home and `--remote-debugging-port`; over the DevTools protocol with Node's own `fetch` and `WebSocket`, fill and submit the join form, wait for the chat list, send a message and read it back from the page, then send a note containing `<script>` and an `<img onerror>` from the other identity and assert the thread holds no `script` or `img` element. Skip when there is no display. No new dependency.

## K. The README

- [ ] **P0-K1** Rewrite `README.md` for what now exists, keeping its plain style and its section order: what Player Two is; quick start (start the hub with Docker, install the window on Windows, join, tag your agent, tag a teammate's, start a channel, let your agent ask); agents and tags; the window; commands; configuration; what Player Two protects and what it does not; deploying the hub on AKS; development. Replace the terminal screenshot with a description of the window. Every command and path in it must be one that exists.
- [ ] **P0-K2** At the top of `docs/ideas.md`, add one line: the list was written for the terminal interface, which is gone; items the window already covers are not marked.

## Done when

1. Every task above is ticked except those marked **(workstation)**.
2. The checks are green in CI, including the smoke test.
3. `docker build` produces a hub image; a container from it passes `test/hub.test.ts` when the test is pointed at it by an environment variable (add that switch to the test).
4. The repository holds no Python.
5. `npm start` on Linux or macOS opens the window, which starts its desk as a separate process.

Report then, with the workstation tasks still open listed for the person.

## Notes

- **P0-A1 to P0-A4: section A cannot be green after each task as it is split.** Moving `test` (A1) breaks the scenario test until its path to the Python project is fixed (A4), and moving the sources (A2) breaks the build until `build.mjs` points at them (A3). Rule 2 wants every commit green, so the work was regrouped: A1 moved all of `app/` up one level, `app/src/*` into `src/` included, which is what leaves `app/` empty, and fixed the scenario test's path in the same commit. A2 moves the sources from there to their homes and points `build.mjs` at them. A3 is the name, `engines` and `.nvmrc`. A4 is left with nothing to change but its box.
- **P0-A1: from the root, `npm run format:check` reads 15 files it never saw from `app/`.** Fourteen are Markdown, where Prettier would re-pad every table in the plan and the README. `*.md` went into `.prettierignore` instead, so the formatter covers what it covered before. The fifteenth, `.pre-commit-config.yaml`, was formatted: three comments lost a space.
- **P0-A1: `tests/test_app_vectors.py` named the fixture by its old path.** It now points at `test/fixtures/python-vectors.json`.
