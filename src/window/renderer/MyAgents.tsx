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

import { MODES } from "../../core/wire.ts";
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

/** Who a grant lets ask. */
function askersOf(grant: GrantView): string {
  return grant.askers.includes("*") ? "anyone on the hub" : grant.askers.join(", ");
}

/** A grant's answers, as the dialog and the list put them. */
function deliveryOf(delivery: GrantView["delivery"]): string {
  return delivery === "post" ? "posted directly" : "kept for your review";
}

interface NewGrantProps {
  readonly repo: string;
  readonly people: readonly string[]; // Everyone else on the hub, who may be named as the one to ask.
  readonly cannot: ChatView["cannot"];
  readonly act: Act;
  readonly onDone: () => void;
}

/** The dialog that makes a grant on the user's agent in `repo`: who may ask, at which of the modes the agent that answers can be held to, how its answers go out, for how long, and how often a day. */
function NewGrant({ repo, people, cannot, act, onDone }: NewGrantProps): JSX.Element {
  const modes = MODES.filter((mode) => cannot[mode] === "");
  const [asker, setAsker] = useState(people[0] ?? "*");
  const [mode, setMode] = useState<PermissionMode>(modes[0] ?? "full");
  const [delivery, setDelivery] = useState<GrantView["delivery"]>("review");
  const [lasts, setLasts] = useState<number>(LASTS[0].seconds);
  const [runs, setRuns] = useState(RUNS);
  const [confirming, setConfirming] = useState(false); // Asking the second yes, for full access posted directly for everyone.
  const [sending, setSending] = useState(false); // While the desk makes the grant: Grant does nothing more, so a second click, or a double click, makes no second grant.
  const grant = (): void => {
    if (sending) {
      return;
    }
    setSending(true);
    act({ do: "grant", repo, askers: [asker], mode, delivery, lasts, runsPerDay: Number(runs) }, (ok) => {
      setSending(false);
      if (ok) {
        onDone();
      }
    });
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (mode === "full" && delivery === "post" && asker === "*") {
      setConfirming(true);
    } else {
      grant();
    }
  };
  if (confirming) {
    return (
      <Modal title={`Let anyone run your ${repo} agent with full access?`} className="sm:max-w-md" onDismiss={onDone}>
        <p>
          Anyone on the hub, and anyone who joins it later, could then have your {repo} agent do anything your account can on this machine, change any file and run any command, without asking you.
          What it writes is posted to the chat before you have read it. Up to {runs} times a day, for {LASTS.find((each) => each.seconds === lasts)?.label.toLowerCase()}, with nobody at your desk.
        </p>
        <p className="flex gap-2">
          <Button type="button" variant="destructive" disabled={sending} onClick={grant}>
            Grant full access to anyone
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
            <option value="*">Anyone on the hub</option>
          </select>
        </Label>
        <Label className={FIELD}>
          What the agent may do
          <select
            name="mode"
            value={mode}
            onChange={(event) => {
              const chosen = event.currentTarget.value;
              setMode(modes.find((each) => each === chosen) ?? mode);
            }}
          >
            {modes.map((each) => (
              <option key={each} value={each}>
                {each}: {ACCESS[each]}
              </option>
            ))}
          </select>
        </Label>
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
        <Button type="submit" className="self-start" disabled={sending}>
          Grant
        </Button>
      </form>
    </Modal>
  );
}

/** The grants that stand on one of the user's agents, each with what it allows, until when, its runs today, and Revoke. */
function Grants({ grants, act }: { readonly grants: readonly GrantView[]; readonly act: Act }): JSX.Element {
  const [revoking, setRevoking] = useState<readonly string[]>([]); // The grants being revoked: their Revoke does nothing more until the desk answers.
  if (grants.length === 0) {
    return <p className="pl-4 text-muted-foreground">No grants: a teammate&rsquo;s request of it waits for you.</p>;
  }
  return (
    <ul className="flex flex-col gap-1 pl-4">
      {grants.map((grant) => (
        <li key={grant.id} data-grant={grant.id} className="flex items-center gap-2">
          <span className="flex-1">
            {askersOf(grant)} · {grant.mode} · {deliveryOf(grant.delivery)} · until <Until expires={grant.expires} /> · {grant.runsToday} of {grant.runsPerDay} runs today
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
                onClick={() => {
                  act({ do: "hold", repo, held: !held });
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
            <Grants grants={view.grants.filter((grant) => grant.repo === repo)} act={act} />
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
                <Grants grants={view.grants.filter((grant) => grant.repo === repo)} act={act} />
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
          cannot={view.cannot}
          act={act}
          onDone={() => {
            setGranting("");
          }}
        />
      )}
    </div>
  );
}
