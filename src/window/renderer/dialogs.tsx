/** What the window asks in a dialog: which channel to join, which repo a channel is about, and, on Cmd+K or Ctrl+K, which chat or message to open. */

import { cn } from "cn";
import { useEffect, useState } from "react";
import type { JSX, ReactNode, SyntheticEvent } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { outcomeSchema } from "../../shared/ipc.ts";
import type { Command as DeskCommand, Hit } from "../../shared/ipc.ts";

const CHOICE = "h-auto w-full justify-start px-2 py-1 font-normal"; // One of the answers listed under the question.
const PAUSE = 250; // Milliseconds without typing before the words are searched for.

/** A modal dialog, open for as long as it is drawn, that reports "" when it is dismissed with Esc, its close button or a click outside it. */
function Modal({ title, onDismiss, className, children }: { readonly title: string; readonly onDismiss: () => void; readonly className?: string; readonly children: ReactNode }): JSX.Element {
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
      <DialogContent className={cn("gap-3 sm:max-w-sm", className)} aria-describedby={undefined}>
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
        <Input
          className="flex-1"
          name="name"
          aria-label="Channel name"
          placeholder="backend"
          pattern="#?[a-z0-9][a-z0-9_\-]{0,31}"
          title="lowercase letters, digits, - and _, at most 32 characters"
          required
          autoFocus
        />
        <Button type="submit">Join</Button>
      </form>
      {others.length > 0 && (
        <ul className="mt-2 max-h-60 overflow-y-auto">
          {others.map((channel) => (
            <li key={channel.name}>
              <Button
                type="button"
                variant="ghost"
                className={CHOICE}
                onClick={() => {
                  onDone(channel.name);
                }}
              >
                {channel.name} <span className="truncate text-muted-foreground">{channel.members.join(", ")}</span>
              </Button>
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
      {repos.length === 0 && <p className="text-muted-foreground">You have no team repos checked out to pin.</p>}
      <ul className="mt-2 max-h-60 overflow-y-auto">
        {repos.map((repo) => (
          <li key={repo}>
            <Button
              type="button"
              variant="ghost"
              className={CHOICE}
              onClick={() => {
                onDone(repo);
              }}
            >
              {repo}
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/**
 * Chats whose name holds what is typed, at once, and after a short pause the messages and answers that hold its words, each with a stretch of its text, the words found picked out.
 * Enter, or a click, reports the command that opens the chat or the message; dismissing it reports null. What was found is drawn as text, the words found as spans made from the desk's pieces.
 */
export function Search({ chats, onDone }: { readonly chats: readonly string[]; readonly onDone: (command: DeskCommand | null) => void }): JSX.Element {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ readonly hits: readonly Hit[]; readonly problem: string }>({ hits: [], problem: "" });
  const words = query.trim();

  useEffect(() => {
    if (words === "") {
      setFound({ hits: [], problem: "" });
      return undefined;
    }
    let wanted = true; // Until more is typed: what is found for words since changed is dropped.
    const timer = setTimeout(() => {
      window.playerTwo
        .command({ do: "search", q: words })
        .then((raw) => {
          const outcome = outcomeSchema.parse(raw);
          if (wanted) {
            setFound(outcome.ok ? { hits: outcome.found ?? [], problem: "" } : { hits: [], problem: outcome.problem });
          }
        })
        .catch(console.error);
    }, PAUSE);
    return (): void => {
      wanted = false;
      clearTimeout(timer);
    };
  }, [words]);

  const named = chats.filter((chat) => chat.includes(words.toLowerCase()));
  return (
    <Modal
      title="Search"
      className="sm:max-w-lg"
      onDismiss={() => {
        onDone(null);
      }}
    >
      {/* The desk has already chosen and ordered what it found, so the list filters nothing itself. */}
      <Command shouldFilter={false} className="p-0">
        <CommandInput aria-label="Search" placeholder="A chat's name, or words its messages hold" value={query} onValueChange={setQuery} autoFocus />
        <CommandList className="mt-1 max-h-96">
          <CommandEmpty>Nothing found.</CommandEmpty>
          {found.problem !== "" && <p className="px-2 py-1.5 text-destructive">{found.problem}</p>}
          {named.length > 0 && (
            <CommandGroup heading="Chats">
              {named.map((chat) => (
                <CommandItem
                  key={chat}
                  value={`chat ${chat}`}
                  onSelect={() => {
                    onDone({ do: "open", chat });
                  }}
                >
                  {chat}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {found.hits.length > 0 && (
            <CommandGroup heading="Messages">
              {found.hits.map((hit) => (
                <CommandItem
                  key={hit.id}
                  value={`note ${hit.id}`}
                  onSelect={() => {
                    onDone({ do: "openNote", id: hit.id });
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-muted-foreground">
                      {hit.sender}
                      {hit.agent === null ? "" : `/${hit.agent} agent`} in {hit.chat}
                    </span>
                    {/* The pieces of one snippet never reorder, so their position is a stable key. */}
                    <span className="line-clamp-2 wrap-anywhere">
                      {hit.snippet.map((piece, at) => (
                        <span key={at} className={piece.hit ? "font-semibold text-tag" : undefined}>
                          {piece.text}
                        </span>
                      ))}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </Modal>
  );
}
