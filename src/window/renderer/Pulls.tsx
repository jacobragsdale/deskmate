/** Azure DevOps in the chat: a pull request a message refers to, as a chip. Every word of it is someone else's and drawn as text; an address opens in the browser only on dev.azure.com. */

import { cn } from "cn";
import type { JSX } from "react";

import { azureWeb, votes } from "../../core/pulls.ts";
import type { PullRequest } from "../../shared/ipc.ts";

const CHIP = "mx-0.5 inline-block max-w-80 truncate rounded-md border bg-muted px-1.5 align-bottom text-xs";

/** A pull request in a few words: its number and title, its status, whether it is a draft, and how its reviewers voted. */
export function pullWords(pull: PullRequest): string {
  const voted = votes(pull.reviewers);
  return [`!${String(pull.id)} ${pull.title}`, pull.status, ...(pull.draft ? ["draft"] : []), ...(voted === "" ? [] : [voted])].join(" · ");
}

/** A link to an address on Azure DevOps, which the main process opens in the browser; the same words as text, opening nothing, for an address anywhere else. */
export function AzureLink({ web, className, title, children }: { readonly web: string; readonly className?: string; readonly title?: string; readonly children: string }): JSX.Element {
  const href = azureWeb(web);
  return href === null ? (
    <span className={className} title={title}>
      {children}
    </span>
  ) : (
    <a className={className} href={href} target="_blank" rel="noreferrer" title={title}>
      {children}
    </a>
  );
}

/** A pull request a message refers to, drawn as a chip of text, which opens it in the browser. */
export function PullChip({ pull }: { readonly pull: PullRequest }): JSX.Element {
  return (
    <span data-pull={pull.id}>
      <AzureLink web={pull.web} className={cn(CHIP, "hover:bg-accent")} title={`${pull.creator}'s pull request from ${pull.source} into ${pull.target}`}>
        {pullWords(pull)}
      </AzureLink>
    </span>
  );
}
