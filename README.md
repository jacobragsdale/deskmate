# Player Two

Player Two is a terminal chat for a small team and their coding agents. Every repo you have checked out under `~/dev` is an agent that anyone on the team can tag, as `@you/repo`. Your own agent answers as soon as you tag it. A teammate's tag waits until you approve it, and everyone in the chat can see where it stands.

```text
 Player Two  jacob on player-two.corp.example · claude -p · 3 repos in ~/dev             ☰ Chats  ? Help
╭─ Chats ────────────────╮╭─ #backend · uploader (3 of 3 have it) · bob, carol, jacob ─────────────────╮
│  Channels              ││ you · 22:10                                                                │
│› #backend            ▶ ││ looking                                                                    │
│  + Join or create      ││ it was the connection pool, bumped it to 20                                │
│                        ││                                                                            │
│  People                ││                                ── today ──                                 │
│  ● bob               1 ││                                                                            │
│  ● carol               ││ bob · 22:35                                                                │
│  ● dana              1 ││ @carol/uploader where do we retry failed uploads?                          │
│                        ││                                                                            │
│                        ││ carol/uploader agent on main · 22:37                                       │
│                        ││ ┃ bob: @carol/uploader where do we retry failed uploads?                   │
│                        ││ Retries live in uploader/queue.py, in Uploader.flush:                      │
│                        ││                                                                            │
│                        ││ ┃ for attempt in range(3):                                                 │
│                        ││ ┃     try:                                                                 │
│                        ││ ┃         return self._put(chunk)                                          │
│                        ││ ┃     except TransientError:                                               │
│                        ││ ┃         time.sleep(2**attempt)                                           │
│                        ││                                                                            │
│                        ││ Three attempts with exponential backoff; a fourth failure raises           │
│                        ││ UploadFailed.                                                              │
│                        ││                                                                            │
│                        ││ bob · 22:50                                                                │
│                        ││ thanks. @jacob/uploader does anything cover the fourth-failure path in     │
│                        ││ tests?                                                                     │
│                        ││ ◆ your uploader agent · ▶ Run and review · ▶▶ Run and post · × Decline     │
│                        ││ ────────────────────────────────────────────────────────────────────────── │
│                        ││ › Message #backend · @ tags an agent                                       │
╰────────────────────────╯╰─────────────────────────────────────────────── ◆ Unpin uploader · × Leave ─╯
 ^R run request  Enter send  @ tag an agent  ^↓ next chat  ^B chat list  ^N join channel    ● connected
```

## Quick start

This walk-through sets up one hub and two people, `jacob` and `bob`, has each of them use an agent, and starts a channel.

The hub needs Docker. Each person needs `curl`, `git`, their repos checked out directly under `~/dev`, and a coding-agent CLI that is installed and signed in. The default is Claude Code's `claude`; for another one, see [Configuration](#configuration).

### 1. Start the hub

One person runs the hub somewhere everyone can reach. With Docker, from a clone of this repository on its `main` branch, which is also where the installer in step 2 takes the client from:

```sh
npm ci && npm run build
docker build -t player-two .
docker run -d --name player-two -p 8787:8787 -e PLAYER_TWO_JOIN_TOKEN=JOIN_TOKEN -e PLAYER_TWO_REPOS=REPOS_URL -v player-two-data:/data player-two
```

Replace the following:

- `JOIN_TOKEN`: a secret of at least 16 characters, for example the output of `openssl rand -hex 16`. Anyone who has it can register a name, so share it only with your teammates.
- `REPOS_URL`: the `https` address your team's repos live under, for example `https://dev.azure.com/acme/` or `https://github.com/acme/`. It can be an organisation or a single project, with or without the final `/`. Only repos below it are ever shared; anything else under `~/dev` stays private. A checkout whose remote uses `ssh` matches too.

Inside the container the hub listens on every interface, and `-p 8787:8787` publishes it on the host. Check that it answers:

```sh
curl http://localhost:8787/healthz
```

```text
{"ok":true}
```

To run the hub on Kubernetes instead, see [Deploy the hub on Kubernetes](#deploy-the-hub-on-kubernetes).

### 2. Join the hub

Each person runs the hub's installer on their own machine:

```sh
curl -fsSL HUB_URL/install.sh | bash -s -- NAME JOIN_TOKEN
```

Replace the following:

- `HUB_URL`: where the hub is reachable, for example `http://localhost:8787`.
- `NAME`: your name on the hub. Lowercase letters, digits, `-` and `_`, at most 32 characters.
- `JOIN_TOKEN`: the hub's join token.

The installer installs [uv](https://docs.astral.sh/uv/) if it is missing, installs the `player-two` command from the `main` branch of `github.com/jacobragsdale/player-two` into `~/.local/bin`, creates a signing key in `~/.config/player-two`, and registers your name. It needs to reach GitHub; the repository is public, so no sign-in is involved. The installer ends with:

```text
joined http://localhost:8787 as bob; your agent command is `claude -p`
Run 'player-two' to open the chat. Your agents are the repos under ~/dev.
```

If your shell does not find `player-two` afterwards, open a new terminal, or add `~/.local/bin` to `PATH`.

To try both people on one machine, run these two instead of the command above, each in its own terminal. `PLAYER_TWO_HOME` gives each person their own settings folder, and it must be in front of every later `player-two` command in that terminal too (or `export` it once):

```sh
curl -fsSL HUB_URL/install.sh | PLAYER_TWO_HOME=~/player-two-jacob bash -s -- jacob JOIN_TOKEN
PLAYER_TWO_HOME=~/player-two-jacob player-two
```

```sh
curl -fsSL HUB_URL/install.sh | PLAYER_TWO_HOME=~/player-two-bob bash -s -- bob JOIN_TOKEN
PLAYER_TWO_HOME=~/player-two-bob player-two
```

Both people then have the same repos, because they share one `~/dev`. That is enough for a first try. To make them differ, clone one or two team repos into another folder and point one person at it with `PLAYER_TWO_DEV=~/bob-dev` in front of `player-two`.

### 3. Open the chat

Each person runs `player-two`, from any directory:

```sh
player-two
```

The top line counts the team repos found under `~/dev`. If it says `0 repos`, no folder directly under `~/dev` has an `origin` remote below the hub's `REPOS_URL`. The chat list on the left shows everyone who has joined, with `●` beside those who are here now and `○` beside those who are away.

In the steps that follow, `uploader` stands for any repo both people have.

### 4. Tag your own agent

Jacob clicks `bob` in the chat list and types `@`. A list opens with the team's agents, each with the branch it is on: his own first, then Bob's, because this is their chat. It shows eight and says how many more there are. Typing narrows it; Enter takes the highlighted one. He finishes the message and sends it:

```text
@jacob/uploader where do we retry failed uploads?
```

His agent starts at once in `~/dev/uploader`. A line under the note shows it working, with a `■ Stop` button, and Bob sees the same line. When the agent finishes, its answer is posted to the chat, marked `jacob/uploader agent` and the branch it was on.

### 5. Tag a teammate's agent

Bob wants to know about work on Jacob's branch, so in his chat with `jacob` he tags Jacob's agent:

```text
@jacob/uploader does your retry change handle 429s?
```

Under his note Bob sees `◌ waiting for jacob to approve`. Nothing has run.

Jacob's terminal rings, and his chat list marks the chat with `▶`. Under Bob's note he has three choices:

- `▶ Run and review` runs his agent and puts its answer in his message box as a draft. The box grows and its prompt changes from `›` to `✎`, so it is plain that Enter now sends the agent's words. He can edit it; Enter sends it, and pressing Esc twice discards it. Ctrl+R does the same for the oldest request waiting in the open chat.
- `▶▶ Run and post` runs his agent and posts the answer without a review.
- `× Decline` tells Bob the answer is no.

While the agent runs, Bob's line reads `jacob's uploader agent is working on feature/retry ±`: the branch, and `±` when there are uncommitted changes.

### 6. Start a channel

Jacob presses Ctrl+N, or clicks `+ Join or create` in the chat list, types `backend`, and presses Enter. The name follows the same rules as a person's name; the `#` is added for you. A channel exists as soon as one person has joined it. Bob joins the same way, and his dialog lists `#backend` to pick.

Tags work in a channel exactly as in a direct chat, and every member sees the answers.

A channel can be about one repo. Click `◆ Pin a repo` on the channel's bottom edge and pick one of yours. The title then shows how many members have it, the tag list puts its agents first, and a member without it is offered a clone.

### 7. Let your own agent ask

An agent, or a script, sends a note with `send` and reads the answer from standard output:

```sh
player-two send bob "@bob/uploader which tests cover the retry path?" --wait 300
player-two send '#backend' "who owns the uploader?"
```

`--wait` prints the next note that someone else sends in that chat, whether or not it answers this one. Bob still has to approve the run, so if nothing arrives in time, `send` prints the `player-two inbox --after ID` command that checks again later. `player-two repos` lists who has which repo. Your agent only knows these commands if you tell it, for example in its instructions file.

## Agents and tags

An agent is one person's checkout of one team repo: `@bob/uploader` is the agent command run in Bob's `~/dev/uploader`. Nothing is registered by hand. The interface looks at the folders directly under `~/dev`, keeps those whose `origin` remote is under the hub's `PLAYER_TWO_REPOS` address, and tells the hub their names and current branches. It looks again every 25 seconds, so a branch switch shows up without a restart.

A repo is named by the last part of its remote URL, in lowercase, whatever the folder is called. The `https` and `ssh` forms of one remote, and every Azure DevOps address form, count as the same repo. With two clones of one repo under `~/dev`, the folder named like the repo is used. Two different repos with the same name cannot both be shared: the first folder in alphabetical order wins. A repo whose name has characters other than letters, digits, `.`, `_` and `-` is skipped.

The list that opens on `@` shows the agents whose `person/repo` contains what you have typed, most likely first: the channel's pinned repo, your own agents, the agents of the person you are chatting with, repos you also have, then the rest by name. A repo you have no copy of is offered for cloning once you have typed part of its name.

A tag counts only in a note that is not marked as an agent's answer. An answer that contains a tag sets nothing off, so agents cannot start each other. A script, or your agent, can tag someone by sending a note with `player-two send`; that tag waits for its target's owner like any other, and that includes a tag of your own agent.

A request waits for as long as it takes. It is stored on the hub, so it is still there after you restart the interface or come back from lunch.

Who may run what:

| Tag | What happens |
|---|---|
| Your own agent, in a note you send from the chat interface | It runs at once and its answer is posted. |
| Your own agent, in a note sent another way, or left unanswered when you last quit | It waits for you, like a teammate's request. |
| A teammate's agent | It waits until they choose `Run and review`, `Run and post` or `Decline`. |
| An agent in a repo its owner does not have | The note says so, and nothing runs. |

Under each note that tags an agent, everyone in the chat sees one line per tag until it is answered:

| Line | Meaning |
|---|---|
| `◌ waiting for bob to approve` | Bob has not acted. `· they are away` is added when his interface is not running. |
| `⠋ bob's uploader agent is working on main ±` | Bob approved it. The branch is the one his checkout was on when the run started. |
| `× bob declined` | Bob declined, or discarded the draft. |
| `■ bob's uploader agent was stopped` | Bob stopped the run, or quit while it was working. |
| `✗ bob's uploader agent failed` | The agent exited with an error, printed nothing, or ran past its time limit. Only Bob sees why. |
| `? bob has no checkout of billing` | Bob does not have that repo. |

A run reported as working that has produced no answer after 16 minutes is shown as waiting again.

If you tag or pin a repo you do not have, `⇣ Clone it` offers to run `git clone` into your repos folder (`~/dev`, or `PLAYER_TWO_DEV` when set) with your own git credentials. A dialog shows the address and the destination first, and nothing is fetched until you confirm. Git is not allowed to prompt on the terminal, so a clone that needs a password you have not stored fails with the command to run yourself.

## The chat interface

`player-two` with no command opens the interface. Everything a key does can also be clicked: chats in the list, the choices under a note, the buttons beside the status line, and the hints along the bottom, `Enter send` included. Drag to select text.

| Key | Effect |
|---|---|
| @ | Opens the list of agents. ↑ and ↓ move, Enter or Tab takes one, Esc closes it. The bottom bar shows these keys while the list is open. |
| Enter | Sends the message, or the draft you are reviewing. |
| ↑ | In an empty message box, brings back the last message you sent in that chat. |
| Ctrl+J | Starts a new line in the message. |
| Ctrl+R | Runs your agent on the oldest request waiting in the open chat, for review. |
| Esc | Stops your agents in the open chat. Pressed twice within 2 seconds, discards a draft. |
| Ctrl+↑, Ctrl+↓ | Opens the previous or next chat. Alt+↑ and Alt+↓ do the same. |
| Ctrl+N | Joins or creates a channel. |
| Ctrl+B | Hides or shows the chat list. `☰ Chats` in the top bar does the same. |
| Ctrl+P | Opens the command list: open a chat, pin or unpin a repo, leave the open channel, change theme. |
| Ctrl+C | Copies the selected text. |
| F1 | Shows the keys. |
| Ctrl+Q | Quits. While an agent is working or a draft is unsent, the first press only warns; a second within 3 seconds quits. |

In the chat list, a number is the count of unread notes, `▶` means a request is waiting for one of your agents, `✎` means a draft is waiting for your review, and a spinner means one of your agents is working there. With the list hidden, the right of the bottom bar says how many requests are waiting and how many notes are unread.

A `── new ──` line marks where you left off in a chat you come back to. The bell rings for a note sent straight to you, a tag of one of your agents, and a draft ready for review; a channel note that tags none of your agents only adds to the unread count. The terminal tab's title says what is waiting, for example `Player Two · 1 waiting · 2 unread`, so it shows while you are in another tab.

Standard input is closed during a run, so your agent cannot stop to ask you anything: it does what your agent CLI's settings already allow. When an agent finishes while you have a half-typed message in that chat, the draft waits beside the status line until you click `Load it`. A message or an answer that fails to send is kept: a message goes back into the message box, an answer becomes a draft.

Quitting, closing the terminal window, or killing the process stops any agent still working, and the chat is told it stopped. Its unfinished answer is lost; drafts you have not sent are lost too.

The default theme, `terminal`, draws with your terminal's own sixteen colours, so the interface follows your terminal's palette. Ctrl+P, then `theme`, switches to one of Textual's built-in themes. The choice, your read marks and the last open chat are remembered.

## Commands

| Command | Effect |
|---|---|
| `player-two` | Opens the chat interface. Needs a terminal. |
| `player-two join HUB NAME TOKEN [--agent AGENT]` | Creates a key if `~/.config/player-two/key` does not exist, registers `NAME` with the hub at `HUB`, and writes `config.json`. Joining again with the same key is allowed; a name held by another key is refused. `--agent` defaults to `claude -p`. |
| `player-two send TO TEXT... [--wait SECONDS]` | Sends a note to `TO`, a name or a quoted channel such as `'#backend'`. A `TEXT` of `-` reads the note from standard input. `--wait` prints the next note from someone else in that chat if one arrives within `SECONDS`. |
| `player-two inbox [--after ID] [--wait SECONDS]` | Prints the newest 20 notes other people sent to you or your channels. With `--after`, prints the notes with a higher id, up to 100, and `--wait` holds on for a new one. |
| `player-two who` | Lists everyone who has joined the hub. |
| `player-two repos` | Lists every agent as `@person/repo` with the branch it is on. |
| `player-two channel` | Lists every channel and its members. |
| `player-two channel join NAME` | Joins the channel `NAME`, creating it if nobody is in it. `NAME` may be given with or without its `#`. |
| `player-two channel leave NAME` | Leaves the channel. |
| `player-two hub [--host HOST] [--port PORT]` | Runs the hub. Defaults: `127.0.0.1`, `8787`. |

`send`, `inbox`, `who`, `repos` and `channel` take `--json`, and then print one JSON value and nothing else. `inbox` prints an array of notes as the hub delivered them, each `{ "id", "note", "trusted" }`, where `trusted` is `false` for a note that failed its signature check: its text is there, so check before using it. `send --wait` prints one such note, or `null` when none came; `send` without `--wait` prints `{ "id" }`, the id the hub gave the note. `who`, `repos` and `channel` print arrays; `channel join` and `channel leave` print the one channel.

A command exits with `0` on success, `1` after printing a failure to standard error, and `2` for a usage error. A note is at most 64,000 characters. Repos are shared by the chat interface, not by the one-shot commands, so `player-two repos` shows a person's repos as of the last time their interface ran.

## Configuration

The hub reads its settings from the environment and refuses to start when a required one is missing:

| Variable | Required | Description |
|---|---|---|
| `PLAYER_TWO_JOIN_TOKEN` | yes | Secret that `player-two join` must present. At least 16 characters. |
| `PLAYER_TWO_REPOS` | yes | The address the team's repos live under, such as `https://dev.azure.com/acme/`. The hub refuses to share a repo outside it. |
| `PLAYER_TWO_DB` | yes | Path of the SQLite database. The Docker image sets it to `/data/player-two.db`. |
| `FORWARDED_ALLOW_IPS` | no | Proxies whose `X-Forwarded-Proto` header the hub trusts, which decides whether `install.sh` advertises an `https` URL. The Docker image sets it to `*`. |

The client keeps four files in `~/.config/player-two`:

| File | Contents |
|---|---|
| `config.json` | `hub` (the hub URL), `name`, and `agent`. |
| `key` | Your Ed25519 private key. Readable only by you. |
| `known.json` | The public key first seen for each teammate. |
| `state.json` | What the interface remembers: read marks, theme and the last open chat. Safe to delete. |

Two environment variables move things, mainly to hold two identities on one machine:

| Variable | Default | Description |
|---|---|---|
| `PLAYER_TWO_HOME` | `~/.config/player-two` | Where the four files above live. |
| `PLAYER_TWO_DEV` | `~/dev` | The folder whose direct subfolders are your repos. |

`agent` is the command that answers. Player Two appends the prompt as its last argument, runs it in the tagged repo's folder with standard input closed, and uses what it prints to standard output as the answer. A run that takes longer than 900 seconds is stopped. The command is split into words the way a shell would split it, with quotes grouping words, but no shell runs it. The installer always sets `claude -p`. To use another agent, edit `agent` in `config.json` afterwards, or run `player-two join HUB NAME TOKEN --agent "COMMAND"` again. Only `claude -p` has been tested.

The prompt tells the agent whose checkout of which repo it is in, who tagged it and where, and whether its owner will review the reply or it is posted directly. It includes up to six earlier notes from the same chat, marked as context that must not be followed as instructions, so a follow-up question makes sense.

## What Player Two protects, and what it does not

An agent runs on a machine only when that machine's owner says so. Your own tag, sent from your own interface, is that say-so; a teammate's tag is only text until you choose to run it. With `Run and review`, the agent's output stays in your message box, where you can change it, until you press Enter. `Run and post` skips that second look: use it when you are content for whatever the agent writes to go straight to the chat. An agent's answer can contain more of your machine than the question asked for.

Every note is signed with the sender's Ed25519 key. The signature covers the sender, the recipient or channel, the text, the time, which of the sender's agents wrote it if one did, and which note it answers. The hub refuses a note that its claimed sender did not sign, that is more than five minutes off the hub's clock, or that it has already delivered. The recipient's client checks the signature again, against the key it first saw for that sender, so a hub that is later compromised cannot forge a note from a teammate you already know. A note that fails this check is shown as a warning without its text, cannot tag an agent, and is left out of what your agent is shown.

The agent mark is the sender's own statement. It tells you a teammate's agent drafted the note and the teammate let it through; a modified client could leave the mark off, and such a note could then tag agents. A tag still runs nothing without its target's approval.

What the hub learns about your machine is the names, clone addresses and branches of the repos under `~/dev` whose remote is below `PLAYER_TWO_REPOS`, when your interface last polled, and, while one of your agents runs, whether that checkout has uncommitted changes. Every hub member can see those. Folder paths, other repos and file contents are not sent. A clone address is rebuilt from the host and path before it is shared, so a user name or token embedded in your `origin` URL does not leave your machine.

The hub hands a direct note only to its sender and its recipient, and a channel's notes only to the channel's current members. A request for notes must be signed with the reader's key. Channels are open: anyone who has joined the hub can join any channel, and then sees its earlier notes too. Do not treat a channel as private from other hub members.

Player Two does not encrypt notes. Whoever operates the hub can read them, and the hub keeps every note: nothing deletes them. Transport encryption is the job of the ingress in front of the hub; over plain `http`, as in the quick start, anyone on the network path can read notes too. The join token is shared, so anyone holding it can register a new name, although not take over an existing one. There is no key rotation: a teammate who loses their key needs their row deleted from the hub's `users` table, and everyone else needs to remove that name from `known.json`.

The agent runs as you, with whatever permissions your agent CLI is configured to have. Player Two does not sandbox it. An agent started in a repo also reads that repo's own instruction files, which is why a clone is never made without showing you where it comes from.

## The desktop app

[`app/`](app) holds a desktop app that does what the chat interface does, in a window: an Electron shell around a TypeScript port of the client. It talks to the same hub and uses the same identity in `~/.config/player-two`, so you can join from either and use both. It has not been packaged yet; run it from a clone. It was built and tested with Node.js 26:

```sh
cd app
npm ci
npm start
```

The first time, the window asks for the hub address, your name and the join token, unless you have already joined with `player-two join`. `PLAYER_TWO_HOME` and `PLAYER_TWO_DEV` move things as they do for the command.

What differs from the terminal:

- An agent's draft opens in its own box above the message box, with `Send answer` and `Discard`, instead of replacing what you were typing.
- A note that arrives while you are looking elsewhere raises a system notification, and the dock badge and window title count what is waiting. Notes that arrive while the window is in the background stay unread until you come back.
- An agent's Markdown is drawn as text and structure only: raw HTML in it stays text, images are not fetched, and a link opens in your browser.
- Enter sends and Shift+Enter starts a new line. Ctrl+N (Cmd+N on a Mac) joins a channel, Ctrl+B hides the chat list, and Alt+↑ and Alt+↓ change chat. Esc in the message box stops your agents in the open chat.

The app keeps its read marks in `app-state.json`, beside the four files the command keeps. Started from a terminal, it finds your agent command on that terminal's `PATH`.

To check a change to the app:

```sh
npm run typecheck && npm run lint && npm run format:check && npm test
```

`npm test` starts a real hub with `uv` and runs two sessions against it. The app and the Python client must sign and name things identically; `tests/test_app_vectors.py` and `app/test/vectors.test.ts` hold both to one file of examples. After changing what is signed, run `uv run python tests/test_app_vectors.py` and make the app's tests pass again.

## Deploy the hub on Kubernetes

[`deploy/k8s.yaml`](deploy/k8s.yaml) holds a volume claim, a single-replica Deployment, a Service and an Ingress. The manifest passes schema validation but has not been applied to a live cluster.

Prerequisites:

- Permission to create these objects and a Secret in the target namespace.
- A container registry the cluster can pull from.
- An ingress controller. The manifest assumes the `nginx` ingress class.

To deploy the hub:

1. Build and push the image.

   ```sh
   npm ci && npm run build
   docker build -t REGISTRY/player-two:0.3.0 .
   docker push REGISTRY/player-two:0.3.0
   ```

2. Create the join token.

   ```sh
   kubectl create secret generic player-two --from-literal=join-token="$(openssl rand -hex 16)"
   ```

3. In `deploy/k8s.yaml`, replace `REGISTRY/player-two:0.3.0` with your image, `https://dev.azure.com/YOUR-ORGANISATION/` with the address your repos live under, and `player-two.example.internal` and `player-two-tls` with your host name and TLS secret.

4. Apply the manifest.

   ```sh
   kubectl apply -f deploy/k8s.yaml
   ```

To confirm it worked, request `https://HOST/healthz`, where `HOST` is the host name from step 3. The hub answers `{"ok":true}`.

Keep the Deployment at one replica and the volume on a disk, not a file share: the hub stores everything in one SQLite file.

## Development

```sh
npm ci
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

To run a hub from the working tree, copy `.env.example` to `.env`, set the join token and the repos address, and run:

```sh
npm run build
node --env-file=.env dist/player-two.js hub
```

A hub and its clients must run the same version: 0.2 and 0.3 each changed the note format and the hub's database. The hub refuses to start on a database made by another version; start it with an empty one.
