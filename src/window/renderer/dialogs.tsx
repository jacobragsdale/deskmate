/** The two questions the window asks in a dialog: which channel to join, and which repo a channel is about. */

import type { JSX, ReactNode, SyntheticEvent } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** A modal dialog, open for as long as it is drawn, that reports "" when it is dismissed with Esc, its close button or a click outside it. */
function Modal({ title, onDismiss, children }: { readonly title: string; readonly onDismiss: () => void; readonly children: ReactNode }): JSX.Element {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      {/* The title says it all, so there is no description to point to. */}
      <DialogContent className="gap-3 sm:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function JoinChannel({ others, onDone }: { readonly others: readonly { readonly name: string; readonly members: readonly string[] }[]; readonly onDone: (name: string) => void }): JSX.Element {
  const join = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    onDone(typeof name === "string" ? name.trim() : "");
  };
  return (
    <Modal
      title="Join or create a channel"
      onDismiss={() => {
        onDone("");
      }}
    >
      <form className="flex gap-1.5" onSubmit={join}>
        <input
          className="flex-1"
          name="name"
          aria-label="Channel name"
          placeholder="backend"
          pattern="#?[a-z0-9][a-z0-9_\-]{0,31}"
          title="lowercase letters, digits, - and _, at most 32 characters"
          required
          autoFocus
        />
        <button type="submit" className="primary">
          Join
        </button>
      </form>
      {others.length > 0 && (
        <ul className="choices">
          {others.map((channel) => (
            <li key={channel.name}>
              <button
                type="button"
                onClick={() => {
                  onDone(channel.name);
                }}
              >
                {channel.name} <span className="quiet">{channel.members.join(", ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function PickRepo({ title, repos, onDone }: { readonly title: string; readonly repos: readonly string[]; readonly onDone: (repo: string) => void }): JSX.Element {
  return (
    <Modal
      title={title}
      onDismiss={() => {
        onDone("");
      }}
    >
      {repos.length === 0 && <p className="quiet">You have no team repos checked out to pin.</p>}
      <ul className="choices">
        {repos.map((repo) => (
          <li key={repo}>
            <button
              type="button"
              onClick={() => {
                onDone(repo);
              }}
            >
              {repo}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
