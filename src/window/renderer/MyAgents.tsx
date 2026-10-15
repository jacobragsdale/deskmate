/**
 * The user's agents, one for each team repo they have checked out, with the grants that let teammates' requests of each run with nobody at the desk: listed with how many runs each let go today,
 * revoked, and made in a dialog. A grant of full access, posted directly, for everyone needs a second yes that says what it means. Grants on repos not checked out here are listed apart, to revoke.
 */

import { cn } from "cn";
import { useState } from "react";
import type { JSX, SyntheticEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { askerWords, MODES, workflowAsker } from "../../core/wire.ts";
import type { PermissionMode } from "../../core/wire.ts";
import type { ChatView, GrantView } from "../../shared/ipc.ts";
import { FIELD } from "./Agents.tsx";
import type { Act } from "./App.tsx";
import { Modal } from "./dialogs.tsx";
import { ACCESS, Until } from "./Message.tsx";

/** How long a grant lasts, as the `grant` command's `lasts` takes it. */
const LASTS = [
  { seconds: 86_400, label: "A day" },
  { seconds: 604_800, label: "A week" },
  { seconds: 2_592_000, label: "30 days" }
] as const;
const RUNS = "20"; // The daily limit a grant is offered with.
const A_WORKFLOW = "workflow:"; // What "Who may ask" holds while a workflow is chosen: no person's name, as none holds a colon.

/** Who a grant lets ask, in words. */
function askersIn(grant: GrantView): string {
  return grant.askers.map(askerWords).join(", ");
}

/** Whom a grant lets ask, from "Who may ask": the person or "*" chosen there, or the workflow named under it, as `workflowAsker` names one. */
function askersOf(asker: string, workflow: Parameters<typeof workflowAsker>[0]): string[] {
  return [asker === A_WORKFLOW ? workflowAsker(workflow) : asker];
}

/**
 * Who could run the agent under a grant to `asker` that is not one person, as the dialog warns of full access for them: anyone on the hub, or whatever sets the workflow named off, a webhook's
 * caller from outside the hub among them; and who they are, in the second yes's question and its button. All "" for a person.
 */
function openTo(asker: string, workflow: Parameters<typeof workflowAsker>[0]): { readonly whoever: string; readonly them: string; readonly grantee: string } {
  if (asker === "*") {
    return { whoever: "Anyone on the hub, and anyone who joins it later,", them: "anyone", grantee: "anyone" };
  }
  if (asker !== A_WORKFLOW) {
    return { whoever: "", them: "", grantee: "" };
  }
  const named = askerWords(workflowAsker({ ...workflow, name: workflow.name === "" ? "…" : workflow.name }));
  return { whoever: `Whatever sets ${named} off, anyone with its webhook’s address among them,`, them: named, grantee: "this workflow" };
}

/**
 * While "Who may ask" is a workflow, the fields that name it: one of the user's channels and the workflow's name there, and what the grant then names, in words, from `workflowAsker`, which
 * makes the asker itself; and that whatever sets the workflow off can then run the agent.
 */
function WorkflowFields({
  asker,
  repo,
  channels,
  chosen,
  choose
}: {
  readonly asker: string;
  readonly repo: string;
  readonly channels: readonly string[];
  readonly chosen: { readonly channel: string; readonly name: string };
  readonly choose: (chosen: { readonly channel: string; readonly name: string }) => void;
}): JSX.Element | null {
  if (asker !== A_WORKFLOW) {
    return null;
  }
  return (
    <>
      <Label className={FIELD}>
        In the channel
        <select
          name="channel"
          value={chosen.channel}
          onChange={(event) => {
            choose({ ...chosen, channel: event.currentTarget.value });
          }}
        >
          {channels.map((channel) => (
            <option key={channel} value={channel}>
              {channel}
            </option>
          ))}
        </select>
      </Label>
      <Label className={FIELD}>
        The workflow&rsquo;s name
        <Input
          className="font-normal"
          name="workflow"
          pattern="[a-z0-9][a-z0-9_\-]{0,31}"
          title="lowercase letters, digits, - and _, at most 32 characters"
          placeholder="ci-failure"
          required
          value={chosen.name}
          onChange={(event) => {
            choose({ ...chosen, name: event.currentTarget.value });
          }}
        />
      </Label>
      <p id="a-workflow" className="-mt-2 text-xs text-warn">
        The grant names {askerWords(workflowAsker({ ...chosen, name: chosen.name === "" ? "…" : chosen.name }))}. Whatever sets it off, anyone with its webhook&rsquo;s address among them, could then
        have your {repo} agent run as the grant says, with nobody at your desk.
      </p>
    </>
  );
}

/**
 * Why the agent that answers would run nothing under a grant at `mode`, so that a request waits for the user all the same; "" when it would run. Below full, an agent over ACP whose permissions
 * were never tested is not taken at its word with nobody watching (see startRun in the session).
 */
function stalled(view: ChatView, mode: PermissionMode): string {
  if (view.cannot[mode] !== "") {
    return view.cannot[mode];
  }
  const label = view.agents.find((agent) => agent.id === view.defaultAgent)?.label ?? "";
  return view.untested && mode !== "full" ? `${label}'s permissions have not been tested, so nothing shows it keeps to less than full with nobody watching: Setup → Test permissions` : "";
}

/** A grant's answers, as the dialog and the list put them. */
function deliveryOf(delivery: GrantView["delivery"]): string {
  return delivery === "post" ? "posted directly" : "kept for your review";
}

interface NewGrantProps {
  readonly repo: string;
  readonly people: readonly string[]; // Everyone else on the hub, who may be named as the one to ask.
  readonly channels: readonly string[]; // The user's channels, in one of which a workflow may be named as the one to ask.
  readonly cannot: ChatView["cannot"];
  readonly untested: string; // Why a grant below full would never run, the agent that answers being over ACP and untested, so that only full can be chosen; "" when it is not.
  readonly act: Act;
  readonly onDone: () => void;
}

/** The dialog that makes a grant on the user's agent in `repo`: who may ask, at which of the modes the agent that answers can be held to, how its answers go out, for how long, and how often a day. */
function NewGrant({ repo, people, channels, cannot, untested, act, onDone }: NewGrantProps): JSX.Element {
  const modes = MODES.filter((mode) => cannot[mode] === "");
  const usable = untested === "" ? modes : modes.filter((mode) => mode === "full"); // Those listed but not these are shown, and cannot be chosen.
  const [asker, setAsker] = useState(people[0] ?? "*");
  const [workflow, setWorkflow] = useState(() => ({ channel: channels[0] ?? "", name: "" })); // The workflow named, while "Who may ask" is a workflow.
  const [mode, setMode] = useState<PermissionMode>(usable[0] ?? "full");
  const [delivery, setDelivery] = useState<GrantView["delivery"]>("review");
  const [lasts, setLasts] = useState<number>(LASTS[0].seconds);
  const [runs, setRuns] = useState(RUNS);
  const [confirming, setConfirming] = useState(false); // Asking the second yes, for full access posted directly for anyone on the hub or a workflow.
  const { whoever, them, grantee } = openTo(asker, workflow);
  const anyoneFull = mode === "full" && whoever !== ""; // Said whatever the delivery: a review reads the answer only after the agent has acted.
  const described = [untested === "" ? "" : "untested", anyoneFull ? "anyone-full" : ""].filter((id) => id !== "").join(" "); // What the mode's field points a screen reader to.
  const [sending, setSending] = useState(false); // While the desk makes the grant: Grant does nothing more, so a second click, or a double click, makes no second grant.
  const grant = (): void => {
    if (sending) {
      return;
    }
    setSending(true);
    act({ do: "grant", repo, askers: askersOf(asker, workflow), mode, delivery, lasts, runsPerDay: Number(runs) }, (ok) => {
      setSending(false);
      if (ok) {
        onDone();
      }
    });
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (mode === "full" && delivery === "post" && whoever !== "") {
      setConfirming(true);
    } else {
      grant();
    }
  };
  if (confirming) {
    return (
      <Modal title={`Let ${them} run your ${repo} agent with full access?`} className="sm:max-w-md" onDismiss={onDone}>
        <p>
          {whoever} could then have your {repo} agent do anything your account can on this machine, change any file and run any command, without asking you. What it writes is posted to the chat before
          you have read it. Up to {runs} times a day, for {LASTS.find((each) => each.seconds === lasts)?.label.toLowerCase()}, with nobody at your desk.
        </p>
        <p className="flex gap-2">
          <Button type="button" variant="destructive" disabled={sending} onClick={grant}>
            Grant full access to {grantee}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Back
          </Button>
        </p>
      </Modal>
    );
  }
  return (
    <Modal title={`A grant on your ${repo} agent`} className="sm:max-w-md" onDismiss={onDone}>
      <form className="flex min-w-0 flex-col gap-3" onSubmit={submit}>
        <Label className={FIELD}>
          Who may ask
          <select
            name="asker"
            value={asker}
            onChange={(event) => {
              setAsker(event.currentTarget.value);
            }}
          >
            {people.map((person) => (
              <option key={person} value={person}>
                {person}
              </option>
            ))}
            <option value="*">Anyone on the hub, not a workflow</option>
            <option value={A_WORKFLOW} disabled={channels.length === 0}>
              A workflow in one of your channels
            </option>
          </select>
        </Label>
        <WorkflowFields asker={asker} repo={repo} channels={channels} chosen={workflow} choose={setWorkflow} />
        <Label className={FIELD}>
          What the agent may do
          <select
            name="mode"
            value={mode}
            aria-describedby={described === "" ? undefined : described}
            onChange={(event) => {
              const chosen = event.currentTarget.value;
              setMode(usable.find((each) => each === chosen) ?? mode);
            }}
          >
            {modes.map((each) => (
              <option key={each} value={each} disabled={!usable.includes(each)}>
                {each}: {ACCESS[each]}
              </option>
            ))}
          </select>
        </Label>
        {untested !== "" && (
          <p id="untested" className="-mt-2 text-xs text-warn">
            Only full can be chosen. {untested}.
          </p>
        )}
        {anyoneFull && (
          <p id="anyone-full" className="-mt-2 text-xs text-warn">
            {whoever} could have your {repo} agent do anything your account can on this machine, change any file and run any command, without asking you
            {delivery === "review" ? ": you would review its answer, but only once it has acted." : "."}
          </p>
        )}
        <Label className={FIELD}>
          Its answer
          <select
            name="delivery"
            value={delivery}
            aria-describedby={delivery === "post" ? "unread" : undefined}
            onChange={(event) => {
              setDelivery(event.currentTarget.value === "post" ? "post" : "review");
            }}
          >
            <option value="review">{deliveryOf("review")}</option>
            <option value="post">{deliveryOf("post")}</option>
          </select>
        </Label>
        {/* Not part of the label, so a screen reader does not read it as the field's name; the select points to it instead. */}
        {delivery === "post" && (
          <p id="unread" className="-mt-2 text-xs text-warn">
            The answer goes to them unread. Even read-only, the agent can read anything on this machine that you can: keep it for your review unless you trust everyone this grant names with that.
          </p>
        )}
        <Label className={FIELD}>
          For
          <select
            name="lasts"
            value={lasts}
            onChange={(event) => {
              setLasts(Number(event.currentTarget.value));
            }}
          >
            {LASTS.map((each) => (
              <option key={each.seconds} value={each.seconds}>
                {each.label}
              </option>
            ))}
          </select>
        </Label>
        <Label className={FIELD}>
          Runs a day, at most
          <Input
            className="font-normal"
            name="runs"
            type="number"
            min={1}
            max={1000}
            required
            value={runs}
            onChange={(event) => {
              setRuns(event.currentTarget.value);
            }}
          />
        </Label>
        <p className="text-xs text-muted-foreground">A run under a grant never asks other agents: nobody is there to see what it asks in your name.</p>
        <Button type="submit" className="self-start" disabled={sending}>
          Grant
        </Button>
      </form>
    </Modal>
  );
}

/** The grants that stand on one of the user's agents, each with what it allows, until when, its runs today, and Revoke. */
function Grants({ grants, view, act }: { readonly grants: readonly GrantView[]; readonly view: ChatView; readonly act: Act }): JSX.Element {
  const [revoking, setRevoking] = useState<readonly string[]>([]); // The grants being revoked: their Revoke does nothing more until the desk answers.
  if (grants.length === 0) {
    return <p className="pl-4 text-muted-foreground">No grants: a teammate&rsquo;s request of it waits for you.</p>;
  }
  return (
    <ul className="flex flex-col gap-1 pl-4">
      {grants.map((grant) => (
        <li key={grant.id} data-grant={grant.id} className="flex items-center gap-2">
          <span className="flex-1">
            {askersIn(grant)} · {grant.mode} · {deliveryOf(grant.delivery)} · until <Until expires={grant.expires} /> · {grant.runsToday} of {grant.runsPerDay} runs today
            {stalled(view, grant.mode) !== "" && <span className="block text-xs text-warn">A request under it waits for you: {stalled(view, grant.mode)}.</span>}
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={revoking.includes(grant.id)}
            onClick={(event) => {
              // The second click of a double click lands on whatever the first put under the pointer: here the next grant's Revoke, once this one has gone.
              if (event.detail > 1) {
                return;
              }
              setRevoking((each) => [...each, grant.id]);
              act({ do: "revoke", id: grant.id }, () => {
                setRevoking((each) => each.filter((id) => id !== grant.id));
              });
            }}
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function MyAgents({ view, act, onClose }: { readonly view: ChatView; readonly act: Act; readonly onClose: () => void }): JSX.Element {
  const [granting, setGranting] = useState(""); // The repo a grant is being made on; "" while none is.
  const [holding, setHolding] = useState<readonly string[]>([]); // The repos being held back, or let answer again: their button does nothing more until the desk answers.
  const answering = view.agents.find((agent) => agent.id === view.defaultAgent)?.label ?? "";
  const people = view.rows.flatMap((row) => (row.here === null ? [] : [row.chat]));
  // Repos with a grant that stands but no checkout here: nothing answers under it now, but it is still the user's to revoke, and answers again if the repo is checked out again.
  const away = [...new Set(view.grants.map((grant) => grant.repo))].filter((repo) => !view.checkouts.some((checkout) => checkout.repo === repo));
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-[max(16px,calc((100%_-_720px)/2))] py-[6vh]">
      <h1 className="text-2xl font-bold">My agents</h1>
      <p className="text-muted-foreground">
        Each team repo you have checked out in {view.dev} is an agent your teammates can tag, and {answering} answers for each. A teammate&rsquo;s request waits for you, unless a grant here lets it
        run with nobody at your desk, as the grant says. A grant ends when it expires or you revoke it.
      </p>
      {view.checkouts.length === 0 && <p>You have no team repo checked out in {view.dev}.</p>}
      <ul className="flex flex-col gap-4">
        {view.checkouts.map(({ repo, branch, held }) => (
          <li key={repo} data-repo={repo} className="flex flex-col gap-1.5">
            <p className="flex items-baseline gap-2">
              <strong>{repo}</strong>
              <span className={cn("flex-1 truncate", held ? "text-warn" : "text-muted-foreground")}>
                on {branch} · {held ? "held back: not shared with the team, and it answers nobody" : `${answering} answers`}
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={holding.includes(repo)}
                onClick={(event) => {
                  // The second click of a double click lands on the button the first one turned around, and would undo it.
                  if (event.detail > 1) {
                    return;
                  }
                  setHolding((each) => [...each, repo]);
                  // What the button says is what is asked for: held back from "Hold back", answering from "Let it answer".
                  act({ do: "hold", repo, held: !held }, () => {
                    setHolding((each) => each.filter((one) => one !== repo));
                  });
                }}
              >
                {held ? "Let it answer" : "Hold back"}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  setGranting(repo);
                }}
              >
                New grant
              </Button>
            </p>
            <Grants grants={view.grants.filter((grant) => grant.repo === repo)} view={view} act={act} />
          </li>
        ))}
      </ul>
      {away.length > 0 && (
        <>
          <h2 className="mt-2 text-lg font-semibold">Grants on repos not checked out here</h2>
          <p className="text-muted-foreground">Nothing answers under these while the repo is not checked out in {view.dev}, but they stand: check it out again and its agent answers under them.</p>
          <ul className="flex flex-col gap-4">
            {away.map((repo) => (
              <li key={repo} data-away={repo} className="flex flex-col gap-1.5">
                <strong>{repo}</strong>
                <Grants grants={view.grants.filter((grant) => grant.repo === repo)} view={view} act={act} />
              </li>
            ))}
          </ul>
        </>
      )}
      <p>
        <Button type="button" variant="outline" onClick={onClose}>
          Back
        </Button>
      </p>
      {granting !== "" && (
        <NewGrant
          repo={granting}
          people={people}
          channels={view.rows.flatMap((row) => (row.here === null ? [row.chat] : []))}
          cannot={view.cannot}
          untested={view.untested ? stalled(view, "read-only") : ""}
          act={act}
          onDone={() => {
            setGranting("");
          }}
        />
      )}
    </div>
  );
}
