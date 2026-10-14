/** Where the user writes: the message box with its list of agents on "@", and above it any agent's draft waiting for their review. */

import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

import { candidates } from "../../core/chat.ts";
import type { Candidate } from "../../core/chat.ts";
import type { ChatView, CurrentView, Notice } from "../../shared/ipc.ts";
import type { Act, Submit } from "./App.tsx";

const TAG_BEING_TYPED = /(?:^|\s)@([\w./-]*)$/;

/** What names one row of the list of agents, for React and for the list's own idea of which row is highlighted. */
function rowOf(pick: Candidate): string {
  return `${pick.owner}/${pick.repo}/${String(pick.clone)}`;
}

interface Props {
  readonly view: ChatView;
  readonly current: CurrentView;
  readonly act: Act;
  readonly submit: Submit;
  readonly tell: (notice: Notice) => void;
}

/** The oldest draft waiting in this chat, for its owner to edit and send, or discard. Keyed by draft, so each starts from the agent's own words. */
function Review({ current, submit, tell, act }: Omit<Props, "view">): JSX.Element | null {
  const draft = current.drafts[0];
  const [text, setText] = useState(draft?.text ?? "");
  const [sending, setSending] = useState(false);
  if (draft === undefined) {
    return null;
  }
  const target = { chat: current.chat, id: draft.id, repo: draft.repo };
  const send = (): void => {
    setSending(true);
    submit({ do: "sendDraft", ...target, text })
      .then((problem) => {
        setSending(false);
        if (problem !== "") {
          tell({ title: `not sent to ${current.chat}`, body: problem, severity: "error" });
        }
      })
      .catch(console.error);
  };
  return (
    <section className="mb-2 rounded-lg border border-warn px-2.5 py-2">
      <p className="mb-1.5 text-warn">
        ✎ Your {draft.repo} agent&rsquo;s answer for {draft.asker}. Nothing is sent until you send it.
        {current.drafts.length > 1 && ` ${String(current.drafts.length - 1)} more waiting.`}
      </p>
      <Textarea
        className="field-sizing-fixed"
        aria-label="Draft answer"
        value={text}
        rows={8}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <div className="mt-1.5 flex gap-1.5">
        <Button type="button" size="sm" disabled={sending || text.trim() === ""} onClick={send}>
          Send answer
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            act({ do: "discardDraft", ...target });
          }}
        >
          × Discard
        </Button>
      </div>
    </section>
  );
}

export function Composer({ view, current, act, submit, tell }: Props): JSX.Element {
  const chat = current.chat;
  const box = useRef<HTMLTextAreaElement>(null);
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({}); // Per chat, what is in its message box.
  const [lastSent, setLastSent] = useState<Readonly<Record<string, string>>>({}); // Per chat, for ↑ to bring back.
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [closedFor, setClosedFor] = useState(""); // The tag being typed when Esc closed the list; typing on opens it again.
  const text = typed[chat] ?? "";
  const setText = (value: string): void => {
    setTyped((all) => ({ ...all, [chat]: value }));
  };

  useEffect(() => {
    box.current?.focus();
  }, [chat]);

  const beforeCaret = text.slice(0, caret);
  const tag = TAG_BEING_TYPED.exec(beforeCaret)?.[1];
  const partner = current.members === null ? chat : null;
  const picks = tag === undefined || `${chat} ${tag}` === closedFor ? { rows: [], more: 0 } : candidates(tag, view.team, view.me, current.pinned?.name ?? null, partner);
  const highlighted = Math.min(picked, picks.rows.length - 1);

  const take = (pick: Candidate | undefined): void => {
    if (pick === undefined || tag === undefined) {
      return;
    }
    const start = caret - tag.length - 1;
    const insert = pick.clone ? "" : `@${pick.owner}/${pick.repo} `;
    setText(text.slice(0, start) + insert + text.slice(caret));
    setCaret(start + insert.length);
    setPicked(0);
    if (pick.clone) {
      act({ do: "clone", repo: pick.repo });
    }
    box.current?.focus();
  };

  const send = (): void => {
    const message = text.trim();
    if (message === "") {
      return;
    }
    setText("");
    setLastSent((all) => ({ ...all, [chat]: message }));
    submit({ do: "send", chat, text: message })
      .then((problem) => {
        if (problem !== "") {
          // Put an unsent message back where it was, unless something newer has been typed there since.
          setTyped((all) => ((all[chat] ?? "") === "" ? { ...all, [chat]: message } : all));
          tell({ title: `not sent to ${chat}`, body: problem, severity: "error" });
        }
      })
      .catch(console.error);
  };

  /** A key while the list of agents is open: move in it, take from it, or close it. */
  const onPickerKey = (key: string): void => {
    if (key === "Escape") {
      setClosedFor(`${chat} ${tag ?? ""}`);
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      setPicked((highlighted + (key === "ArrowDown" ? 1 : -1) + picks.rows.length) % picks.rows.length);
    } else {
      take(picks.rows[highlighted]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const recalled = lastSent[chat];
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (picks.rows.length > 0 && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) {
      event.preventDefault();
      onPickerKey(event.key);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === "ArrowUp" && text === "" && recalled !== undefined) {
      event.preventDefault();
      setText(recalled);
    } else if (event.key === "Escape" && current.running) {
      act({ do: "stopAll", chat }); // Every run of the user's here, on a reply as on any other message: the desk knows which they are.
    }
  };

  return (
    <div className="border-t px-4 pt-2 pb-2.5">
      <Review key={`${chat} ${current.drafts[0]?.id ?? ""} ${current.drafts[0]?.repo ?? ""}`} current={current} act={act} submit={submit} tell={tell} />
      <Popover open={picks.rows.length > 0}>
        <PopoverAnchor asChild>
          <Textarea
            ref={box}
            className="min-h-0 resize-none field-sizing-fixed"
            aria-label={`Message ${chat}`}
            placeholder={`Message ${chat} · @ tags an agent · Enter sends, Shift+Enter starts a new line`}
            rows={Math.min(8, text.split("\n").length)}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
              setPicked(0);
            }}
            onSelect={(event) => {
              setCaret(event.currentTarget.selectionStart);
            }}
            onKeyDown={onKeyDown}
          />
        </PopoverAnchor>
        {/* The message box keeps the focus and its keys move, take and close; the list only shows the rows and which one they are on. */}
        <PopoverContent
          side="top"
          align="start"
          className="w-80 p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <Command shouldFilter={false} disablePointerSelection value={picks.rows[highlighted] === undefined ? "" : rowOf(picks.rows[highlighted])}>
            <CommandList label="Agents">
              {picks.rows.map((pick) => (
                <CommandItem
                  key={rowOf(pick)}
                  value={rowOf(pick)}
                  onMouseDown={(event) => {
                    event.preventDefault(); // Keep the caret in the message box.
                  }}
                  onSelect={() => {
                    take(pick);
                  }}
                >
                  <span className="truncate">
                    {pick.clone ? (
                      <span className="text-muted-foreground">
                        ⇣ clone {pick.repo} into {view.dev}
                      </span>
                    ) : (
                      <>
                        @{pick.owner}/{pick.repo} <span className="text-muted-foreground">{pick.branch}</span>
                      </>
                    )}
                  </span>
                </CommandItem>
              ))}
              {picks.more > 0 && <div className="px-2 py-1.5 text-muted-foreground">{picks.more} more · keep typing</div>}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
