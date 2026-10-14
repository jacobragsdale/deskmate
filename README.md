# Player Two

Player Two is a chat for a small team and their coding agents. Every repo you have checked out under `~/dev` is an agent that anyone on the team can tag, as `@you/repo`. Your own agent answers as soon as you tag it. A teammate's tag waits until you approve it, and everyone in the chat can see where it stands.

It has three parts. The hub is one small server the team shares; it keeps the notes. The window is a desktop app, on Windows an Electron program. The desk is your side of it: your identity, your repos and your agents. On Windows the desk runs inside WSL, where your repos and your agent's command line are; on Linux and macOS it runs beside the window. The `player-two` command speaks to the same hub, for scripts and for agents.

The window has the chat list on the left: channels, then people, each person with a dot that is filled while they are here, and beside each chat a count of unread notes and a mark for anything waiting on you. The open chat is on the right: its title with the members and any repo the channel is about, the notes, a line under each note that tags an agent saying where that agent stands, and the message box at the bottom with a status line under it.

## Quick start

This walk-through sets up one hub and two people, `jacob` and `bob`, has each of them use an agent, and starts a channel.

The hub needs Docker. Each person needs Windows with WSL 2 and Ubuntu, and inside Ubuntu: `git`, their repos checked out directly under `~/dev`, and a coding agent's command line installed and signed in. The default agent is Cursor's; GitHub Copilot's is the other choice offered, and any other command can be typed in (see [Configuration](#configuration)). On Linux or macOS the window runs from a clone of this repository instead; see [Development](#development).

### 1. Start the hub

One person runs the hub somewhere everyone can reach. With Docker, from a clone of this repository:

```sh
npm ci && npm run build
docker build -t player-two .
```

The hub also hands teammates the Windows installer, from a folder of three files: `player-two-setup.exe`, `wsl-runtime.tar.gz` and `wsl-runtime.tar.gz.sha256`. Pushing a version tag such as `v0.4.0` to GitHub runs the Release workflow, which builds all three and keeps them with its run as the artifact `player-two-v0.4.0`. Fetch them into a folder named `downloads`:

```sh
gh run download RUN_ID --name player-two-v0.4.0 --dir artifact
mkdir downloads
cp artifact/release/player-two-setup.exe artifact/dist/wsl-runtime.tar.gz artifact/dist/wsl-runtime.tar.gz.sha256 downloads/
```

Then start the hub:

```sh
docker run -d --name player-two -p 8787:8787 -e PLAYER_TWO_JOIN_TOKEN=JOIN_TOKEN -e PLAYER_TWO_REPOS=REPOS_URL -e PLAYER_TWO_DOWNLOADS=/downloads -v "$PWD/downloads:/downloads:ro" -v player-two-data:/data player-two
```

Replace the following:

- `RUN_ID`: the Release workflow's run for the tag, as `gh run list --workflow release.yml` lists it.
- `JOIN_TOKEN`: a secret of at least 16 characters, for example the output of `openssl rand -hex 16`. Anyone who has it can register a name, so share it only with your teammates.
- `REPOS_URL`: the `https` address your team's repos live under, for example `https://dev.azure.com/acme/` or `https://github.com/acme/`. It can be an organisation or a single project, with or without the final `/`. Only repos below it are ever shared; anything else under `~/dev` stays private. A checkout whose remote uses `ssh` matches too.

Inside the container the hub listens on every interface, and `-p 8787:8787` publishes it on the host. Check that it answers:

```sh
curl http://localhost:8787/healthz
```

```text
{"ok":true,"now":1791990000}
```

`now` is the hub's clock. To run the hub on AKS instead, see [Deploy the hub on AKS](#deploy-the-hub-on-aks).

### 2. Install the window

Each person opens the hub's address in a browser, for example `http://localhost:8787`. The page there has the installer and three steps:

1. Install WSL with Ubuntu if you have not: in PowerShell, `wsl --install -d Ubuntu`, then restart and open Ubuntu once to make your user.
2. Download the Player Two installer and run it.
3. Open Player Two and join with the hub's address, your name and the join token.

The first time Player Two starts, it installs its runtime into your WSL distribution: Node 26 and the `player-two` command, under `~/.player-two`, with the command linked as `~/.local/bin/player-two`. It does the same after an update, and keeps the runtime before as well. The installer is not signed; a team that wants it signed signs it with its own certificate.

On Linux, someone who wants only the command runs the hub's install script, which installs the same runtime:

```sh
curl -fsSL HUB_URL/install.sh | sh
```

### 3. Join

The window opens on a form: the hub's address, your name, the join token, and your agent. A name is lowercase letters, digits, `-` and `_`, at most 32 characters. Joining creates a signing key in `~/.config/player-two` and registers your name with it. A copy built for your team's hub (see [Configuration](#configuration)) has the address filled in.

Each time it starts, the window checks the machine. If something it needs is missing, such as the repos folder, `git`, the agent's command or the hub, the Setup page opens with what it found and a command to copy for each thing to fix. See [The window](#the-window).

The chat list shows everyone who has joined, with a filled dot beside those who are here now. The status line counts the team repos found under `~/dev`. If it says `0 repos`, no folder directly under `~/dev` has an `origin` remote below the hub's `REPOS_URL`.

In the steps that follow, `uploader` stands for any repo both people have.

### 4. Tag your own agent

Jacob clicks `bob` in the chat list and types `@`. A list opens above the message box with the team's agents, each with the branch it is on: his own first, then Bob's, because this is their chat. It shows eight and says how many more there are. Typing narrows it; Enter takes the highlighted one. He finishes the message and sends it:

```text
@jacob/uploader where do we retry failed uploads?
```

His agent starts at once in `~/dev/uploader`. A line under the note shows it working, with the seconds it has taken and a `■ Stop` button, and Bob sees that it is working. When the agent finishes, its answer is posted to the chat, marked `jacob/uploader agent` and the branch it was on, with a coloured edge down its left side.

### 5. Tag a teammate's agent

Bob wants to know about work on Jacob's branch, so in his chat with `jacob` he tags Jacob's agent:

```text
@jacob/uploader does your retry change handle 429s?
```

Under his note Bob sees `◌ waiting for jacob to approve`. Nothing has run.

Jacob's window notifies him, and his chat list marks the chat with `▶`. Under Bob's note he has three choices:

- `▶ Run and review` runs his agent and puts its answer in a box of its own above the message box, as a draft. He can edit it, then `Send answer` sends it, or `× Discard` drops it.
- `▶▶ Run and post` runs his agent and posts the answer without a review.
- `× Decline` tells Bob the answer is no.

While the agent runs, Bob's line reads `jacob's uploader agent is working on feature/retry ±`: the branch, and `±` when there are uncommitted changes.

### 6. Start a channel

Jacob presses Ctrl+N, or clicks `+ Join or create` in the chat list, types `backend`, and presses Enter. The name follows the same rules as a person's name; the `#` is added for you. A channel exists as soon as one person has joined it. Bob joins the same way, and his dialog lists `#backend` to pick.

Tags work in a channel exactly as in a direct chat, and every member sees the answers.

A channel can be about one repo. Click `◆ Pin a repo` in the channel's title and pick one of yours. The title then shows how many members have it, the tag list puts its agents first, and a member without it is offered a clone.

### 7. Let your own agent ask

An agent, or a script, sends a note with `player-two send` and reads the answer from standard output. In WSL the window has installed the command as `~/.local/bin/player-two`:

```sh
player-two send bob "@bob/uploader which tests cover the retry path?" --wait 300
player-two send '#backend' "who owns the uploader?"
```

`--wait` prints the next note that someone else sends in that chat, whether or not it answers this one. Bob still has to approve the run, so if nothing arrives in time, `send` prints the `player-two inbox --after ID` command that checks again later. `player-two repos` lists who has which repo. Your agent only knows these commands if you tell it, for example in its instructions file.

## Agents and tags

An agent is one person's checkout of one team repo: `@bob/uploader` is the agent command run in Bob's `~/dev/uploader`. Nothing is registered by hand. The desk looks at the folders directly under `~/dev`, keeps those whose `origin` remote is under the hub's `PLAYER_TWO_REPOS` address, and tells the hub their names and current branches. It looks again each time it asks the hub for news, at least every 25 seconds, so a branch switch shows up without a restart.

A repo is named by the last part of its remote URL, in lowercase, whatever the folder is called. The `https` and `ssh` forms of one remote, and every Azure DevOps address form, count as the same repo. With two clones of one repo under `~/dev`, the folder named like the repo is used. Two different repos with the same name cannot both be shared: the first folder in alphabetical order wins. A repo whose name has characters other than letters, digits, `.`, `_` and `-` is skipped.

The list that opens on `@` shows the agents whose `person/repo` contains what you have typed, most likely first: the channel's pinned repo, your own agents, the agents of the person you are chatting with, repos you also have, then the rest by name. A repo you have no copy of is offered for cloning once you have typed part of its name.

A tag counts only in a note that is not marked as an agent's answer. An answer that contains a tag sets nothing off, so agents cannot start each other. A script, or your agent, can tag someone by sending a note with `player-two send`; that tag waits for its target's owner like any other, and that includes a tag of your own agent.

A request waits for as long as it takes. It is stored on the hub, so it is still there after you restart the window or come back from lunch.

Who may run what:

| Tag | What happens |
|---|---|
| Your own agent, in a note you send from the window | It runs at once and its answer is posted. |
| Your own agent, in a note sent another way, or left unanswered when you last quit | It waits for you, like a teammate's request. |
| A teammate's agent | It waits until they choose `Run and review`, `Run and post` or `Decline`. |
| An agent in a repo its owner does not have | The note says so, and nothing runs. |

Under each note that tags an agent, everyone in the chat sees one line per tag until it is answered:

| Line | Meaning |
|---|---|
| `◌ waiting for bob to approve` | Bob has not acted. `· they are away` is added when his window is not open. |
| `bob's uploader agent is working on main ±` | Bob approved it. The branch is the one his checkout was on when the run started. |
| `× bob declined` | Bob declined, or discarded the draft. |
| `■ bob's uploader agent was stopped` | Bob stopped the run, or quit while it was working. |
| `✗ bob's uploader agent failed` | The agent exited with an error, printed nothing, or ran past its time limit. Only Bob sees why. |
| `? bob has no checkout of billing` | Bob does not have that repo. |
| `? nobody named bob has joined` | There is no such person on the hub. |

A run reported as working that has produced no answer after 16 minutes is shown as waiting again.

If you tag or pin a repo you do not have, `⇣ Clone it` offers to run `git clone` into your repos folder (`~/dev`, or `PLAYER_TWO_DEV` when set) with your own git credentials. A dialog shows the address and the destination first, and nothing is fetched until you confirm. Git is not allowed to prompt for a password, so a clone that needs one you have not stored fails with the command to run yourself.

## The window

Everything can be clicked: chats in the list, the choices under a note, the buttons in a channel's title. Light or dark follows the system's setting.

| Key | Effect |
|---|---|
| @ | Opens the list of agents. ↑ and ↓ move, Enter or Tab takes one, Esc closes it. |
| Enter | Sends the message. |
| Shift+Enter | Starts a new line in the message. |
| ↑ | In an empty message box, brings back the last message you sent in that chat. |
| Esc | Stops your agents in the open chat. |
| Alt+↑, Alt+↓ | Opens the previous or next chat. |
| Ctrl+N | Joins or creates a channel. Cmd+N on a Mac. |
| Ctrl+B | Hides or shows the chat list. Cmd+B on a Mac. |

In the chat list, a number is the count of unread notes, `▶` means a request is waiting for one of your agents, `✎` means a draft is waiting for your review, and a spinner means one of your agents is working there. Hovering a mark says what it means, and hovering a note's time gives its full date. Drag the chat list's edge to make it wider or narrower; the window remembers the width.

A `new` line marks where you left off in a chat you come back to. A note that arrives while you are looking elsewhere raises a system notification, with a sound for a note sent straight to you, a tag of one of your agents, and a draft ready for review. The window's title says what is waiting, for example `Player Two · 1 waiting · 2 unread`, and on macOS and Linux its badge counts it. Notes that arrive while the window is in the background stay unread until you come back.

An agent's answer is drawn as Markdown, as text and structure only: raw HTML in it stays text, images are not fetched, and a link opens in your browser.

Standard input is closed during a run, so your agent cannot stop to ask you anything: it does what your agent's settings already allow. A message that fails to send goes back into the message box.

Closing the window stops any agent still working, and the chat is told it stopped. While an agent is working or a draft is unsent, the window asks first. An unfinished answer is lost, and so are drafts you have not sent.

The Setup page lists what Player Two needs and whether it found it: Node, your identity, the hub and the way to it, the clocks, the repos folder and your repos, `git` and whether it reaches the team's repos without asking, and your agent's command. Each problem has a command to copy that fixes it; the page never runs one itself. `Check again` checks again, and on Windows the page also chooses the WSL distribution the desk runs in. It opens by itself when the desk cannot start or a check fails at launch, and from `Setup` beside the connection state in the status line. `player-two doctor` prints the same list in a terminal.

## Commands

| Command | Effect |
|---|---|
| `player-two join HUB NAME TOKEN [--agent AGENT]` | Creates a key if `~/.config/player-two/key` does not exist, registers `NAME` with the hub at `HUB`, and writes `config.json`. Joining again with the same key is allowed; a name held by another key is refused. `--agent` defaults to Cursor's `agent -p --output-format text`. |
| `player-two send TO TEXT... [--wait SECONDS]` | Sends a note to `TO`, a name or a quoted channel such as `'#backend'`. A `TEXT` of `-` reads the note from standard input. `--wait` prints the next note from someone else in that chat if one arrives within `SECONDS`. |
| `player-two inbox [--after ID] [--wait SECONDS]` | Prints the newest 20 notes other people sent to you or your channels. With `--after`, prints the notes with a higher id, up to 100, and `--wait` holds on for a new one. |
| `player-two who` | Lists everyone who has joined the hub. |
| `player-two repos` | Lists every agent as `@person/repo` with the branch it is on. |
| `player-two channel` | Lists every channel and its members. |
| `player-two channel join NAME` | Joins the channel `NAME`, creating it if nobody is in it. `NAME` may be given with or without its `#`. |
| `player-two channel leave NAME` | Leaves the channel. |
| `player-two doctor` | Checks what Player Two needs on this machine, as the window's Setup page does, and prints each check with the command that fixes it. Exits `1` when a check failed. |
| `player-two desk` | Runs the desk with no window, speaking JSON lines on standard input and output. The window starts it; it is not for typing at. |
| `player-two hub [--host HOST] [--port PORT]` | Runs the hub. Defaults: `127.0.0.1`, `8787`. |
| `player-two hub verify` | Walks the event log in the database `PLAYER_TWO_DB` names and says whether its chain holds, or the first `seq` where it breaks: an event changed or taken out since it was stored. Exits `1` when it breaks. |

`send`, `inbox`, `who`, `repos`, `channel` and `doctor` take `--json`, and then print one JSON value and nothing else. `inbox` prints an array of notes as the hub delivered them, each `{ "id", "note", "trusted" }`, where `trusted` is `false` for a note that failed its signature check: its text is there, so check before using it. `send --wait` prints one such note, or `null` when none came; `send` without `--wait` prints `{ "id" }`, the id the hub gave the note. `who`, `repos`, `channel` and `doctor` print arrays; `channel join` and `channel leave` print the one channel.

A command exits with `0` on success, `1` after printing a failure to standard error, and `2` for a usage error; `player-two` with no command prints its usage and exits `2`. A note is at most 64,000 characters. Repos are shared by the desk, not by the one-shot commands, so `player-two repos` shows a person's repos as of the last time their window was open.

## Configuration

The hub reads its settings from the environment and refuses to start when a required one is missing:

| Variable | Required | Description |
|---|---|---|
| `PLAYER_TWO_JOIN_TOKEN` | yes | Secret that a join must present. At least 16 characters. |
| `PLAYER_TWO_REPOS` | yes | The address the team's repos live under, such as `https://dev.azure.com/acme/`. The hub refuses to share a repo outside it. |
| `PLAYER_TWO_DB` | yes | Path of the SQLite database. The Docker image sets it to `/data/player-two.db`. |
| `PLAYER_TWO_DOWNLOADS` | no | A folder holding `player-two-setup.exe`, `wsl-runtime.tar.gz` and `wsl-runtime.tar.gz.sha256`. With it, the hub serves a page at `/` with the installer and the install steps, the files under `/downloads/`, and `/install.sh`; without it, those answer `404`. |

The address the page and the install script give is the one the request came to, with `https` when the `X-Forwarded-Proto` header says so.

Your identity is in `~/.config/player-two`, inside WSL on Windows:

| File | Contents |
|---|---|
| `config.json` | `hub` (the hub URL), `name`, and `agent`. |
| `key` | Your Ed25519 private key. Readable only by you. |
| `known.json` | The public key first seen for each teammate. |
| `app-state.json` | Read marks and the last open chat. Safe to delete. |

Two environment variables move things, mainly to hold two identities on one machine:

| Variable | Default | Description |
|---|---|---|
| `PLAYER_TWO_HOME` | `~/.config/player-two` | Where the four files above live. |
| `PLAYER_TWO_DEV` | `~/dev` | The folder whose direct subfolders are your repos. |

The runtime the window installs is in `~/.player-two`: each version under `runtime/`, `current` linking to the one in use and `previous` to the one before. On Windows the window keeps one file of its own, `settings.json` in `%APPDATA%\Player Two`, with the WSL distribution chosen on the Setup page; with none chosen it uses WSL's default.

`agent` is the command that answers. The join form offers Cursor, `agent -p --output-format text`, and Copilot, `copilot -s --allow-all-tools --no-ask-user -p`, or another command typed in. Player Two appends the prompt as its last argument, runs it in the tagged repo's folder with standard input closed, and uses what it prints to standard output as the answer. A run that takes longer than 900 seconds is stopped. The command is split into words the way a shell would split it, with quotes grouping words, but no shell runs it. To change it later, edit `agent` in `config.json`, or run `player-two join HUB NAME TOKEN --agent "COMMAND"` again. The desk finds the command on the `PATH` a login shell has, so tools installed through `nvm` or `npm -g` are found.

The prompt tells the agent whose checkout of which repo it is in, who tagged it and where, and whether its owner will review the reply or it is posted directly. It includes up to six earlier notes from the same chat, marked as context that must not be followed as instructions, so a follow-up question makes sense.

A team's own build of the window can carry its hub's address, so the join form asks only for a name, the token and the agent: set `PLAYER_TWO_HUB_URL` when building, as an `http` or `https` address with no `/` at the end. The Release workflow takes it from a repository variable of the same name.

## What Player Two protects, and what it does not

An agent runs on a machine only when that machine's owner says so. Your own tag, sent from your own window, is that say-so; a teammate's tag is only text until you choose to run it. With `Run and review`, the agent's output stays in the draft box, where you can change it, until you send it. `Run and post` skips that second look: use it when you are content for whatever the agent writes to go straight to the chat. An agent's answer can contain more of your machine than the question asked for.

The window draws text written by other people and their agents, and cannot run it. A note is drawn as text, an agent's Markdown as elements with any raw HTML left as text, images in it are not fetched, and the page's content security policy lets it load scripts and styles only from the app's own files. The page has no access to Node or to Electron beyond a few calls to the window's own process.

Every note is signed with the sender's Ed25519 key. The signature covers the sender, the recipient or channel, the text, the time, which of the sender's agents wrote it if one did, and which note it answers. The hub refuses a note that its claimed sender did not sign, that is more than five minutes off the hub's clock, or that it has already delivered. Every request to the hub is signed too, over the method and the path it is for. The recipient's desk checks a note's signature again, against the key it first saw for that sender, so a hub that is later compromised cannot forge a note from a teammate you already know. A note that fails this check is shown as a warning without its text, cannot tag an agent, and is left out of what your agent is shown.

The agent mark is the sender's own statement. It tells you a teammate's agent drafted the note and the teammate let it through; a modified client could leave the mark off, and such a note could then tag agents. A tag still runs nothing without its target's approval.

What the hub learns about your machine is the names, clone addresses and branches of the repos under `~/dev` whose remote is below `PLAYER_TWO_REPOS`, when your desk last polled, and, while one of your agents runs, whether that checkout has uncommitted changes. Every hub member can see those. Folder paths, other repos and file contents are not sent. A clone address is rebuilt from the host and path before it is shared, so a user name or token embedded in your `origin` URL does not leave your machine.

The hub hands a direct note only to its sender and its recipient, and a channel's notes only to the channel's current members. A request for notes must be signed with the reader's key. Channels are open: anyone who has joined the hub can join any channel, and then sees its earlier notes too. Do not treat a channel as private from other hub members.

Player Two does not encrypt notes. Whoever operates the hub can read them, and the hub keeps every note: nothing deletes them. Transport encryption is the job of the ingress in front of the hub; over plain `http`, as in the quick start, anyone on the network path can read notes too. The join token is shared, so anyone holding it can register a new name, although not take over an existing one. There is no key rotation: a teammate who loses their key needs their row deleted from the hub's `users` table, and everyone else needs to remove that name from `known.json`.

The agent runs as you, with whatever permissions your agent's command line is configured to have. Player Two does not sandbox it. An agent started in a repo also reads that repo's own instruction files, which is why a clone is never made without showing you where it comes from.

## Deploy the hub on AKS

[`deploy/k8s.yaml`](deploy/k8s.yaml) holds a volume claim, a single-replica Deployment, a Service and an Ingress. The manifest passes schema validation but has not been applied to a live cluster.

Prerequisites:

- Permission to create these objects and a Secret in the target namespace.
- A container registry the cluster can pull from.
- An ingress controller. The manifest assumes the `nginx` ingress class.

To deploy the hub:

1. Build and push the image.

   ```sh
   npm ci && npm run build
   docker build -t REGISTRY/player-two:0.4.0 .
   docker push REGISTRY/player-two:0.4.0
   ```

2. Create the join token.

   ```sh
   kubectl create secret generic player-two --from-literal=join-token="$(openssl rand -hex 16)"
   ```

3. In `deploy/k8s.yaml`, replace `REGISTRY/player-two:0.4.0` with your image, `https://dev.azure.com/YOUR-ORGANISATION/` with the address your repos live under, and `player-two.example.internal` and `player-two-tls` with your host name and TLS secret.

4. Apply the manifest.

   ```sh
   kubectl apply -f deploy/k8s.yaml
   ```

To confirm it worked, request `https://HOST/healthz`, where `HOST` is the host name from step 3. The hub answers `{"ok":true,"now":…}`.

Keep the Deployment at one replica and the volume on an Azure Disk (AKS's `managed-csi` storage class, the default), not Azure Files: the hub stores everything in one SQLite file, which needs the locking a disk gives. To serve the installer from the hub, copy the three files of [step 1](#1-start-the-hub) into a folder on the volume, such as `/data/downloads`, with `kubectl cp`, and add `PLAYER_TWO_DOWNLOADS=/data/downloads` to the container's environment.

## Development

It is built and tested with Node.js 26:

```sh
npm ci
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

`npm test` builds first, since one test starts the built command. On Linux or macOS, `npm start` builds and opens the window, which starts its desk as a separate process. `PLAYER_TWO_HOME` and `PLAYER_TWO_DEV` move things as they do for the command.

To run a hub from the working tree, copy `.env.example` to `.env`, set the join token and the repos address, and run:

```sh
npm run build
node --env-file=.env dist/player-two.js hub
```

The window's smoke test starts Electron on the built app and drives it over the DevTools protocol. It needs a display, and skips without one; CI runs it under `xvfb-run`:

```sh
npm run build
xvfb-run --auto-servernum node --test test/window.smoke.ts
```

`test/hub.test.ts` runs against a hub of its own, or against the one `PLAYER_TWO_TEST_HUB` names, such as a container from the image started with the join token `a-join-token-for-tests`, `PLAYER_TWO_REPOS=https://dev.azure.com/acme/` and an empty database:

```sh
PLAYER_TWO_TEST_HUB=http://ADDRESS:8787 node --test test/hub.test.ts
```

To build the Windows installer yourself rather than through the Release workflow:

1. On Linux, build the runtime archive. It downloads Node 26 from nodejs.org, checks it against the published digests, and writes `dist/wsl-runtime.tar.gz` and `dist/wsl-runtime.tar.gz.sha256`.

   ```sh
   npm run build
   node scripts/build-runtime.ts
   ```

2. On Windows, build, put the two files into `dist/`, and package. The packaging scripts package what is in `dist/` and build nothing first, because a build empties `dist/`.

   ```sh
   npm run build
   npm run package:win
   ```

The installer is `release/player-two-setup.exe`. `npm run package:linux` makes an AppImage in `release/` the same way.

The Release workflow does both on a tag that starts with `v`, and keeps the installer, the archive and its digest with its run. A repository variable named `PLAYER_TWO_HUB_URL` gives its installers the team's hub address.

What is signed is pinned by `test/fixtures/signing-vectors.json`. After changing it on purpose, run `node scripts/make-vectors.ts` and commit the file with the change.

A hub and its clients must run the same version. 0.4 changed what every signature covers, so its clients cannot use a 0.3 hub, and the notes a 0.3 hub kept would fail their signature check: start a 0.4 hub with an empty database. The hub refuses to start on a database laid out for another version of its schema.
