# Workstation checklist

What only a real workstation can prove: Windows 11, WSL2 Ubuntu, the team's proxy, Cursor and Copilot. The agent building on the server cannot run any of this. Work through the part for a phase once that phase is otherwise done, tick what passes, and write what did not under "Findings" at the end so the next sitting can fix it.

## Before you start

- [ ] The hub is running on AKS and `curl https://HUB/healthz` answers from inside WSL.
- [ ] Ubuntu trusts the certificate the hub presents. If `curl` complains, add the internal CA: copy it to `/usr/local/share/ca-certificates/` and run `sudo update-ca-certificates`.
- [ ] `HTTPS_PROXY` and `NO_PROXY` are set in WSL as the team sets them, and `NO_PROXY` covers the hub's host.
- [ ] Cursor's command line (`agent`) and Copilot's (`copilot`) are installed inside WSL and signed in. Note where each lives: `which agent copilot`.

## Phase 0

Install the Windows installer from the release run.

- [ ] The installer runs and the window opens.
- [ ] On first launch the window unpacks its runtime into Ubuntu: `ls ~/.deskmate/current/bin` in WSL shows `node`, `deskmate` and `deskmate-desk`.
- [ ] `deskmate --help` works in a new WSL terminal. If not, `~/.local/bin` is not on `PATH`.
- [ ] The setup page is all green, or says exactly what is wrong and how to fix it. Break one thing on purpose (rename the key file) and check the page says so.
- [ ] Joining through the form works, and `~/.config/deskmate` appears in WSL, not on the Windows side.
- [ ] The chat list shows the right count of repos from WSL's `~/dev`.
- [ ] Tag your own agent with Cursor chosen. It answers. Write down the exact one-shot command that worked.
- [ ] The same with Copilot chosen.
- [ ] Start a long run and press Stop. In WSL, `pgrep -fa agent` (or `copilot`) shows nothing left behind.
- [ ] Close the window during a run. Again nothing is left behind, and the chat says the run stopped.
- [ ] A teammate tags your agent while the window is in the background: Windows shows a notification, and clicking it opens that chat.
- [ ] The taskbar badge or title shows what is waiting.
- [ ] Quit and reopen: the window starts its desk within a few seconds. Note how long a cold start takes after a reboot.
- [ ] Development inside WSL: in a clone, `npm ci && npm start` opens the window through WSLg.

## Phase 2

- [ ] Add `deskmate mcp` to Cursor using the snippet on the setup page. Cursor lists deskmate's tools. Note the file it had to go in.
- [ ] The same for Copilot's command line.
- [ ] From the editor's agent, "search deskmate for the retry discussion" returns notes.
- [ ] With `--allow-send`, the editor's agent asks a teammate's agent, the teammate approves, and the answer comes back as the tool's result.
- [ ] A `deskmate://note/…` link clicked in Windows opens the window at that note.

## Phase 3

- [ ] Setup page, "Agents": Cursor over ACP passes `agent-acp`. Copilot over ACP passes it.
- [ ] "Test permissions" for Cursor: does it ask before writing? Record yes or no.
- [ ] The same for Copilot. Record yes or no.
- [ ] Accept a teammate's request `read-only` with an agent that passed: it cannot change a file.
- [ ] Accept one `supervised`: a card appears when it wants to edit, and "Refuse" stops the edit.
- [ ] The activity panel shows steps as they happen, with file paths relative to the checkout.
- [ ] If Cursor's ACP mode failed either check, it stays configured as a one-shot agent. Confirm the window then offers only `full` for it and says why.

## Phase 4

- [ ] The tray icon appears on Windows 11. Closing the window with a live grant hides it instead of quitting.
- [ ] With the window hidden, a teammate's request under your grant is answered.
- [ ] After signing out of Windows and back in, the window starts hidden and the desk is running in WSL.

## Phase 6

- [ ] With no token saved, the `azure` check finds one through git's credential helper inside WSL. If it does not, save a personal access token on the setup page and check again.
- [ ] `!123` in a room pinned to an Azure DevOps repo draws a chip with the right title.
- [ ] A pasted pull request address draws the same chip.
- [ ] A branch room's header shows the branch's pull request and latest build.
- [ ] "Create pull request" on a scratch repo pushes the branch and opens one.
- [ ] Save one real response from each Azure call into `test/fixtures/azure/`, with names and addresses replaced, and run `npm test`.

## Findings

Write here what failed, with the exact message, and anything that behaved differently from what a phase file says.
