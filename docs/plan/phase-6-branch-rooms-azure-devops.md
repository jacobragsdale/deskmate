# Phase 6: branch rooms, patches, and Azure DevOps

Goal: a branch has a room. In it, an agent can hand over a change as a patch that a person reads and applies with a click, and the branch's pull request and build are in view. The team's code stays on Azure DevOps; Player Two hosts no git.

Depends on: phase 5.

Borrowed from Buzz: the branch is the room, and a patch is a message. Borrowed from T3 Code: Azure DevOps pull requests, looked up and created from the app.

## A. Branch rooms

- [ ] **P6-A1** `channel.pin` carries `branch`: `{ repo, branch }`, where `branch` may be `null` for a room about the whole repo. The hub stores it; `GET /channels` reports it. The `pin` command takes a branch.
- [ ] **P6-A2** The current view for a room pinned to a branch lists who is on that branch, from what everyone advertises: "on this branch: bob, jacob". Members whose checkout is on another branch are listed as elsewhere, with the branch.
- [ ] **P6-A3** A suggestion in the chat list when I and at least one teammate are on the same branch of the same repo, the branch is not the repo's default, and no room is pinned to it: "bob is also on uploader/feature-retry · Start a room". It creates a channel named from the repo and branch, cut and cleaned to fit a channel's name with a number added if taken, and pins it. Dismissing a suggestion is remembered in `app-state.json`.
- [ ] **P6-A4** In a branch room the tag list leads with the agents that are on that branch.
- [ ] **P6-A5** Tests for the naming function and the suggestion rule in `test/core.test.ts`, and for the pinned branch in `test/hub.api.test.ts`.

## B. Patches

**Where a run happens.** From this phase, a teammate's request accepted at any mode above `read-only` runs in a throwaway git worktree, so the owner's working tree is never touched by someone else's request. A `read-only` run stays in the checkout itself, so it can see uncommitted work. A request I make of my own agent runs in place, as now.

- [ ] **P6-B1** `src/desk/worktree.ts`: `open(checkout, jobId)` runs `git worktree add --detach ~/.player-two/worktrees/<first 12 of jobId> HEAD` and returns its path; `collect(path)` runs `git add -A` then `git diff --cached --binary HEAD` there and returns the diff; `close(path)` removes it with `git worktree remove --force`. On start, the desk removes worktrees left by a crash. Tests against a real temporary repository.
- [ ] **P6-B2** The session uses a worktree as above. When accepting, the window says which: "runs on a clean copy of `a1b2c3d`; your uncommitted changes are not included".
- [ ] **P6-B3** After such a run, a non-empty diff is published as a `patch` event, referring to the request: the repo as a `RepoRef`, the base commit, the branch, a title (the first line of the agent's answer, cut to 80 characters), and the diff. The same review-or-post choice that governs the answer governs the patch: with review, the owner sees the diff beside the draft and nothing is sent until they send it.
- [ ] **P6-B4** A diff over 512,000 characters is not sent. The worktree is kept, the answer says the change was too large to send as a patch, and the owner gets a notice with the path.
- [ ] **P6-B5** `src/core/diff.ts`, pure: parse a unified diff into files and hunks for display, and `unsafePaths(diff)` listing any path that is absolute, contains a `..` part, or is inside `.git/`. `touchesInstructions(diff)` lists files an agent would read as instructions: `AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.github/copilot-instructions.md`, `.player-two/`. Tests for each.
- [ ] **P6-B6** In the window a patch is a card: title, the files with added and removed line counts, and the diff folded per file, drawn from `diff.ts` as text. No HTML from the diff is ever inserted.
- [ ] **P6-B7** "Apply" on the card, for anyone with a checkout of that repo. The desk: refuses if `unsafePaths` is not empty; runs `git apply --check --3way` with the diff on standard input; then asks, with a native dialog that names the repo, the branch the checkout is on, the files, a warning if the tree has uncommitted changes, and a separate warning if `touchesInstructions` is not empty. Only on yes does it run `git apply --3way`. It never passes `--unsafe-paths`. Afterwards it publishes `patch.applied`.
- [ ] **P6-B8** "Apply to a new branch": when the base commit exists in the recipient's checkout, create `player-two/<first 8 of the patch id>` from it and apply there, leaving the current branch alone. Offered alongside "Apply".
- [ ] **P6-B9** `review` events: "Approve" and "Request changes" with an optional comment on a patch card; shown on the card as who said what.
- [ ] **P6-B10** In the two-session scenario: bob asks jacob's agent for a change; jacob accepts at `auto-edits`; the scripted agent writes a file; jacob's own working tree is unchanged; a patch card reaches bob; bob applies it and the file appears in bob's checkout; a patch with a `../` path is refused before git is called.

## C. Azure DevOps

Every call to Azure DevOps is made by the desk, with the person's own token, from inside WSL. The hub never holds a token and never calls Azure.

Things to know before writing it:

- REST base: `https://dev.azure.com/{organisation}/{project}/_apis/…`, with `api-version=7.1` on every call.
- A repo's organisation, project and name come from its key (`dev.azure.com/acme/platform/uploader`), which `src/core/` already derives from every form of the remote.
- **An unauthenticated call answers `203` with a sign-in page, not `401`.** Treat `203`, or any response that is not JSON, as "not signed in".
- The team is behind a proxy that may re-sign TLS. The runtime's Node is started with `--use-env-proxy` and `--use-system-ca` (task P0-H1), so `fetch` honours `HTTPS_PROXY` and `NO_PROXY` and trusts the certificates Ubuntu trusts.

Tasks:

- [ ] **P6-C1** `src/desk/azure.ts`: finding a token, in this order: the environment variable `AZURE_DEVOPS_EXT_PAT`; a token saved in `~/.config/player-two/azure.json` (mode `0600`); `git credential fill` for the repo's host and path, with terminal prompts off and a ten-second limit. Send it as Basic authentication; if that is answered `203` and the credential came from git, try the same secret once as a Bearer token. Remember which worked for the session. Never log a token.
- [ ] **P6-C2** The calls, each returning parsed data or a problem in words, each with a timeout:

  | Function | Call |
  |---|---|
  | `repository(ref)` | `GET …/_apis/git/repositories/{repo}` for its id, default branch and web address. |
  | `pullRequest(ref, id)` | `GET …/_apis/git/repositories/{repo}/pullrequests/{id}` |
  | `pullRequestsFor(ref, branch)` | `GET …/pullrequests?searchCriteria.sourceRefName=refs/heads/{branch}&searchCriteria.status=all&$top=5` |
  | `latestBuild(ref, branch)` | `GET …/_apis/build/builds?repositoryId={id}&repositoryType=TfsGit&branchName=refs/heads/{branch}&$top=1&queryOrder=queueTimeDescending` |
  | `createPullRequest(ref, { source, target, title, description, draft })` | `POST …/pullrequests` |

  Parse responses with zod schemas that keep only the fields used and ignore the rest: title, status, draft flag, source and target branches, creator's display name, each reviewer's display name and vote, web address; a build's definition name, status, result and web address.
- [ ] **P6-C3** `test/azure.test.ts` against a small in-process fake of those routes, with fixtures in `test/fixtures/azure/` written from Microsoft's documented response shapes: each call parses; `203` with HTML is reported as not signed in; a `404` says the repo or pull request was not found; a slow answer times out.
- [ ] **P6-C4** A setup check `azure`, skipped when the hub's repos address is not on `dev.azure.com`: a token was found, and `repository` works for one shared repo. Its fix text explains the three ways to supply a token and the scopes a personal access token needs: Code, read and write; Build, read. The setup page has a field that saves a token to `azure.json`.
- [ ] **P6-C5** Pull request references. In a chat whose pinned repo is on Azure DevOps, `!123` in a message is a reference to that repo's pull request 123. In any chat, a pasted pull request address (`https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`) is one too. The desk resolves each once and caches it for a minute; the window draws a chip with the title, the status and the votes, which opens the pull request in the browser. One that cannot be resolved is left as plain text.
- [ ] **P6-C6** A branch room's header shows the branch's pull request (title, status, draft, a summary of votes such as "2 approved, 1 waiting") and its latest build (name and result), each a link. The desk refreshes them every 60 seconds while that room is open and the user is looking. With no pull request it shows "No pull request · Create one".
- [ ] **P6-C7** "Create pull request" in a branch room: a dialog with the title and description filled from the branch's commit subjects (`git log <default>..HEAD --format=%s`), the target set to the repo's default branch, and a draft switch. If the branch is not on the remote or is ahead of it, the desk first asks to run `git push -u origin <branch>`. On success it posts a message in the room with the link.
- [ ] **P6-C8** After "Apply to a new branch", the patch card offers "Push and open a pull request", which is the same flow with the patch's title.
- [ ] **P6-C9** When the latest build for an open branch room changes to failed, the user gets a notice. It is local to each person; nothing is posted to the chat.
- [ ] **P6-C10** **(workstation)** With a real token on a scratch repo: the token is found through git's credential helper inside WSL; a `!` reference and a pasted address both draw chips; the header shows a pull request and a build; a pull request is created. Save one real response of each call, with names removed, over the fixtures written in P6-C3, and fix any schema that does not parse them.

## Done when

1. Every task is ticked except the one marked **(workstation)**, and the checks are green.
2. In the scenario, jacob asks bob's agent for a change, bob approves the run, jacob reads the diff in the chat and applies it, and neither person's uncommitted work was touched along the way.
3. Against the fake Azure server, a branch room shows its pull request and build, and "Create pull request" makes one.
4. The README documents branch rooms, patches and their confirmation, and the Azure DevOps setup, and states that tokens stay on the person's machine.
