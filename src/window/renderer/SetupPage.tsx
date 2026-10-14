/** The setup check as a page: each item with how it stands and what was found, its fix with a button to copy it, "Check again", and on Windows the distribution the desk runs in. */

import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import { z } from "zod";

import { checkSchema, distroChoiceSchema, outcomeSchema } from "../../shared/ipc.ts";
import type { Check, DistroChoice, Notice } from "../../shared/ipc.ts";

const checksSchema = z.array(checkSchema).readonly();

const MARKS = { ok: "✓", warn: "!", fail: "✗", skip: "–" } as const;

/** Ask for the setup check. With `again`, a desk that is not up is started afresh first, so what the user fixed is tried. */
export async function runSetupCheck(again: boolean): Promise<readonly Check[]> {
  return checksSchema.parse(await window.playerTwo.doctor(again));
}

interface Props {
  readonly problem: string; // Why the desk will not start; "" when it is up.
  readonly initial: readonly Check[] | null; // A list already in hand, from the check at launch; null to ask for one.
  readonly onClose: (() => void) | null; // Null when there is nothing else to show, because the desk is not up.
  readonly tell: (notice: Notice) => void;
}

export function SetupPage({ problem, initial, onClose, tell }: Props): JSX.Element {
  const [checks, setChecks] = useState<readonly Check[] | null>(initial);
  const [busy, setBusy] = useState(false);
  const [distros, setDistros] = useState<DistroChoice | null>(null);

  const failed = useCallback(
    (error: unknown): void => {
      tell({ title: "the setup check did not finish", body: error instanceof Error ? error.message : String(error), severity: "error" });
    },
    [tell]
  );

  const check = useCallback(
    (again: boolean): void => {
      setBusy(true);
      runSetupCheck(again)
        .then(setChecks, failed)
        .finally(() => {
          setBusy(false);
        });
    },
    [failed]
  );

  useEffect(() => {
    if (initial === null) {
      check(false);
    }
    window.playerTwo
      .distros()
      .then((raw) => {
        setDistros(distroChoiceSchema.nullable().parse(raw));
      })
      .catch(failed);
  }, [initial, check, failed]);

  const choose = (name: string | null): void => {
    setBusy(true);
    window.playerTwo
      .distro(name)
      .then(async (raw) => {
        const outcome = outcomeSchema.parse(raw);
        if (!outcome.ok) {
          tell({ title: "could not change the distribution", body: outcome.problem, severity: "error" });
        }
        setDistros(distroChoiceSchema.nullable().parse(await window.playerTwo.distros()));
        setChecks(await runSetupCheck(false));
      })
      .catch(failed)
      .finally(() => {
        setBusy(false);
      });
  };

  const copy = (fix: string): void => {
    navigator.clipboard.writeText(fix).then(
      () => {
        tell({ title: "", body: "Copied.", severity: "info" });
      },
      (error: unknown) => {
        tell({ title: "could not copy", body: error instanceof Error ? error.message : String(error), severity: "error" });
      }
    );
  };

  return (
    <div className="setup-page">
      <h1>Setup</h1>
      {problem !== "" && <p className="stopped">Player Two cannot start its desk: {problem}</p>}
      {distros !== null && (
        <label>
          Linux distribution
          <select
            value={distros.chosen ?? ""}
            disabled={busy}
            onChange={(event) => {
              choose(event.currentTarget.value === "" ? null : event.currentTarget.value);
            }}
          >
            <option value="">WSL&rsquo;s default</option>
            {distros.names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {checks === null ? (
        <p className="empty">Checking…</p>
      ) : (
        <ul className="checks">
          {checks.map((item) => (
            <li key={item.id} className={item.status}>
              <span className="mark" title={item.status}>
                {MARKS[item.status]}
              </span>
              <div>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
                {item.fix !== "" && (
                  <p className="fix">
                    <code>{item.fix}</code>
                    <button
                      type="button"
                      onClick={() => {
                        copy(item.fix);
                      }}
                    >
                      Copy
                    </button>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => {
            check(true);
          }}
        >
          {busy ? "Checking…" : "Check again"}
        </button>
        {onClose !== null && (
          <button type="button" onClick={onClose}>
            Back
          </button>
        )}
      </p>
    </div>
  );
}
