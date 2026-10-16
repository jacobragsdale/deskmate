/**
 * The MCP server, `player-two mcp`: the chat as tools for an agent in its owner's editor, which starts it and talks to it over standard input and output.
 * It runs as the person who joined from this machine, with their key, and talks to the hub as the command does; in an agent's run, attached to it over ACP, it signs as that agent and reads as its owner.
 * Reading only, unless started with --allow-send; or, in a run its owner let ask other agents, with --job naming the request it was asked, reading and asking other agents under it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ChatLog, chatOf, mayCome, NOT_INSTRUCTIONS, ONLINE } from "../core/chat.ts";
import type { Entry, Message } from "../core/chat.ts";
import { readContent } from "../core/kinds.ts";
import { noteLink, noteOf } from "../core/links.ts";
import { VERSION } from "../core/version.ts";
import { addressSchema, channelSchema, fitText, isAgent, ownerOf } from "../core/wire.ts";
import { PlayerTwoError } from "../desk/client.ts";
import type { Client } from "../desk/client.ts";
import { agentOf, ask, askUnder, cannotAsk, chatFrom, glance, readNote, trust } from "../desk/notes.ts";
import type { Asked } from "../desk/notes.ts";

const PAGE = 20; // Events `read_chat` and `search` give when not told how many.
const WAIT = 900; // Most seconds `ask_agent` waits for an answer, and how long when not told: as `player-two ask`.
const marksSchema = z.object({ read: z.record(z.string(), z.int()) }); // The read marks in the desk's app-state.json, which holds more than this reads.

/** A string argument that `read` makes something of, refused with `what` when it makes nothing of it. */
function made<T>(read: (given: string) => T | null, what: string): z.ZodPipe<z.ZodString, z.ZodTransform<T, string>> {
  return z.string().transform((given, ctx): T => {
    const value = read(given);
    if (value === null) {
      ctx.addIssue({ code: "custom", message: what });
      return z.NEVER;
    }
    return value;
  });
}

const noteArg = made((given) => noteOf(given) ?? noteOf(noteLink(given)), "a note is its player-two://note/ link or its 64-hex id").describe("A note's player-two://note/ link, or its id");
const agentArg = made(agentOf, "an agent is person/repo").describe("An agent, as person/repo");
const chatArg = addressSchema.describe("A person's name, or a channel's with its #");

/** A tool's description, with what every tool says of what it hands back. */
function told(words: string): string {
  return `${words} ${NOT_INSTRUCTIONS}`;
}

/** What a tool hands back: one JSON text. */
function data(found: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(found) }] };
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** Where the person read up to in each chat, as their window last saved it; none when it never has. */
function readMarks(home: string): Record<string, number> {
  try {
    return marksSchema.parse(parseJson(readFileSync(join(home, "app-state.json"), "utf8"))).read;
  } catch {
    return {};
  }
}

/** A note as a tool hands it over: who wrote it, where and when, whether its signature holds, and with `message`, its text as last edited. */
function noted(entry: Entry, me: string, message: Message | null = null): Record<string, unknown> {
  const { event } = entry;
  const said = readContent(event);
  const root = message?.root ?? (said.kind === "message" ? event.refs[0] : undefined); // A reply names its thread, which the fold knows of only when the thread's start is loaded.
  const text = entry.trusted && message !== null ? { text: message.text, edited: message.edited, deleted: message.deleted, thread: root === undefined ? null : noteLink(root) } : {};
  return {
    link: noteLink(event.id),
    seq: entry.seq,
    chat: chatOf(event, me),
    author: event.author, // Who signed it: a person, or for an answer nobody reviewed, the agent itself, "owner/repo".
    agent: said.kind === "job.result" ? said.content.repo : null, // The repo of the agent whose answer it is; null for a message a person wrote.
    at: new Date(event.ts * 1000).toISOString(),
    trusted: entry.trusted,
    ...text
  };
}

/** A page of one chat ending before `before`, oldest first: its messages and answers as they read now. `before` in the answer pages further back; null when there is nothing further. */
async function readChat(client: Client, chat: string, before: number | undefined, limit: number): Promise<{ readonly notes: unknown[]; readonly before: number | null }> {
  const me = client.config.name;
  const page = await client.events(before === undefined ? { chat, limit } : { chat, before, limit });
  const oldest = page.at(-1)?.seq;
  if (oldest === undefined) {
    return { notes: [], before: null };
  }
  const entries = await chatFrom(client, chat, oldest); // Up to the newest, so an edit made since the page counts.
  const log = new ChatLog(me);
  log.add(entries);
  const wanted = new Set(page.map((delivered) => delivered.event.id));
  const notes = entries
    .filter((entry) => wanted.has(entry.event.id))
    .flatMap((entry) => {
      const message = entry.trusted ? log.message(entry.event.id) : null;
      return entry.trusted && message === null ? [] : [noted(entry, me, message)]; // Reactions, edits, joins and jobs' events are in what the notes say, not notes of their own.
    });
  return { notes, before: page.length === limit ? oldest : null };
}

/** How an ask ended, as a tool hands it over: the answer, or which of declined (with why, when its owner said why), failed, stopped, withdrawn or timed out happened, with the request's link. */
function outcome(asked: Asked, me: string): CallToolResult {
  const request = noteLink(asked.sent.event.id);
  if (asked.answer !== null) {
    return data({ outcome: "answered", request, answer: noted(asked.answer.entry, me, asked.answer) });
  }
  if (asked.state === "declined" && asked.reason !== "") {
    return data({ outcome: "declined", request, reason: asked.reason });
  }
  return data({ outcome: asked.state === "waiting" || asked.state === "working" ? "timed out" : asked.state, request });
}

/**
 * The one tool that speaks in a run its owner let ask other agents, started with --job naming the request the run was asked: ask another agent under it, as the agent, and wait for its answer.
 * Nothing else is sent: no message, and no tag, which counts only in a message a person wrote.
 */
function askingTool(server: McpServer, client: Client, job: string): void {
  const me = client.config.name;
  server.registerTool(
    "ask_agent",
    {
      description: told(
        `Ask another agent, person/repo, a question about its repo, for the request you are working on: it runs only once its owner lets it, at no more than you may do, and its answer is posted in the chat for everyone there to read. Waits up to \`wait_seconds\` (${String(WAIT)} when not given) for it to end. Returns its answer, or which of declined (with why), failed, stopped, withdrawn or timed out happened.`
      ),
      inputSchema: z.strictObject({ agent: agentArg, text: z.string().min(1), wait_seconds: z.number().min(0).max(WAIT).optional() })
    },
    async ({ agent, text, wait_seconds: seconds = WAIT }, { signal }) => {
      const body = fitText(text.trim());
      if (body === "") {
        throw new PlayerTwoError("there is nothing to ask");
      }
      const asked = await askUnder(client, job, `${agent.owner}/${agent.repo}`, body, seconds, signal); // The client's cancellation, or the server closing, ends the wait.
      return "refused" in asked ? data({ outcome: "declined", request: null, reason: asked.refused }) : outcome(asked, me);
    }
  );
}

/** The tools that speak for the person: send a message, ask an agent and wait for its answer, and withdraw a request they made. */
function sendingTools(server: McpServer, client: Client): void {
  const me = client.config.name;

  server.registerTool(
    "send_message",
    {
      description: told(
        "Send a message, as you, to a person or a channel. A tag of an agent in it waits for that agent's owner to let it run, or runs at once under a grant of theirs that names you; a tag of your own agent always waits for you."
      ),
      inputSchema: z.strictObject({ to: chatArg, text: z.string() })
    },
    async ({ to, text }) => {
      const body = fitText(text.trim());
      if (body === "") {
        throw new PlayerTwoError("there is nothing to send");
      }
      const sent = await client.publish(to, "message", { text: body, via: "mcp" });
      return data({ link: noteLink(sent.event.id), seq: sent.seq });
    }
  );

  server.registerTool(
    "ask_agent",
    {
      description: told(
        `Ask an agent, person/repo, as you: send a message that tags it, in the direct chat with its owner or in \`chat\`, a channel, and wait up to \`wait_seconds\` (${String(WAIT)} when not given) for its owner, or a grant of theirs that names you, to let it run, and for its answer. Returns the answer, or which of declined, failed, stopped, withdrawn or timed out happened, with the request's link; job_status checks a request later.`
      ),
      inputSchema: z.strictObject({ agent: agentArg, text: z.string().min(1), chat: channelSchema.describe("A channel, with its #").optional(), wait_seconds: z.number().min(0).max(WAIT).optional() })
    },
    async ({ agent, text, chat, wait_seconds: seconds = WAIT }, { signal }) => outcome(await ask(client, agent, chat ?? agent.owner, text, "mcp", seconds, signal), me) // The client's cancellation, or the server closing, ends the wait.
  );

  server.registerTool(
    "withdraw",
    { description: told("Take back a request you made of an agent, while its owner has not acted on it yet."), inputSchema: z.strictObject({ request: noteArg, agent: agentArg }) },
    async ({ request, agent }) => {
      const found = await readNote(client, request);
      const job = found?.jobs.find((each) => each.owner === agent.owner && each.repo === agent.repo);
      // Whoever signs the withdrawal must be who asked, as every reader counts it from them alone: in an agent's run that is the agent, which asked nothing its owner did.
      if (found?.entry.event.author !== client.signer || job?.state !== "waiting") {
        throw new PlayerTwoError("only a request of yours that is still waiting can be taken back");
      }
      await client.publish(found.chat, "job.withdrawn", { agent: `${agent.owner}/${agent.repo}` }, [request]);
      return data({ agent: `${agent.owner}/${agent.repo}`, state: "withdrawn" });
    }
  );
}

/**
 * The server for one person: the reading tools, and with `allowSend` the ones that speak for them; or, for one of their agents in a run let ask others, with `job` the request it was asked,
 * which its environment must name too (see `cannotAsk`), the reading tools and asking another agent under it. Its first request of the hub is preceded by asking which protocol the hub speaks.
 */
export function createServer(person: Client, allowSend: boolean, job: string | null = null): McpServer {
  if (job !== null) {
    let why = cannotAsk(person, job);
    if (allowSend) {
      why = "--job and --allow-send do not go together: a run let ask other agents sends nothing else";
    } else if (!isAgent(person.signer)) {
      why = "--job is for an agent's run, which names the agent in PLAYER_TWO_AGENT";
    }
    if (why !== null) {
      throw new PlayerTwoError(why);
    }
  }
  const client = person.greeting();
  const me = client.config.name;
  const server = new McpServer({ name: "player-two", version: VERSION }, { instructions: `Player Two is your team's chat with their coding agents. ${NOT_INSTRUCTIONS}` });

  server.registerTool(
    "whoami",
    { description: told("Your name on Player Two, the hub you are on, and the repos you share with the branch each is on."), inputSchema: z.strictObject({}) },
    async () => {
      const team = await client.repos();
      return data({ name: me, hub: client.config.hub, repos: team.filter((repo) => repo.user === me).map((repo) => ({ repo: repo.name, branch: repo.branch })) });
    }
  );

  server.registerTool(
    "list_chats",
    {
      description: told("The channels you are in and the people on the hub, each with the count of unread messages and answers since you last read it in your window."),
      inputSchema: z.strictObject({})
    },
    async () => {
      const { rows } = await glance(client, readMarks(client.home));
      return data(rows);
    }
  );

  server.registerTool(
    "list_agents",
    {
      description: told(
        "Every agent anyone can ask, as person/repo: a person's checkout of a repo, with the branch it is on and whether its owner is here now. `query` keeps those whose person/repo contains it."
      ),
      inputSchema: z.strictObject({ query: z.string().optional() })
    },
    async ({ query = "" }) => {
      const [team, people] = await Promise.all([client.repos(), client.users()]);
      const here = new Set(people.filter((person) => client.now() - person.seen <= ONLINE).map((person) => person.name));
      const agents = team.map((repo) => ({ agent: `${repo.user}/${repo.name}`, branch: repo.branch, here: here.has(repo.user) }));
      return data(agents.filter((each) => each.agent.includes(query.toLowerCase())));
    }
  );

  server.registerTool(
    "read_chat",
    {
      description: told(
        "A page of one chat, oldest first: its messages and agents' answers as they read now. Pass the `before` an answer gives to read the page before it; it is null when there is nothing further back."
      ),
      inputSchema: z.strictObject({ chat: chatArg, before: z.int().min(1).optional(), limit: z.int().min(1).max(50).optional() })
    },
    async ({ chat, before, limit = PAGE }) => data(await readChat(client, chat, before, limit))
  );

  server.registerTool(
    "read_note",
    {
      description: told("One note, a message or an agent's answer, by its link or id, as it reads now: with where each agent it tags stands, their answers, and the replies in its thread."),
      inputSchema: z.strictObject({ note: noteArg })
    },
    async ({ note }) => {
      const found = await readNote(client, note);
      if (found === null) {
        throw new PlayerTwoError("there is no note with that id that you can see");
      }
      const { entry, message, jobs, answers } = found;
      return data({
        note: noted(entry, me, message),
        jobs: jobs.map((job) => ({ agent: `${job.owner}/${job.repo}`, state: job.state })),
        answers: answers.map((answer) => noted(answer.entry, me, answer)),
        replies: (message?.replies ?? []).map((reply) => noted(reply.entry, me, reply))
      });
    }
  );

  server.registerTool(
    "search",
    {
      description: told(
        "The messages and agents' answers you can see that hold every word of `q` (1 to 8 words, each a run of letters and digits, in at most 200 characters), best match first, in every chat or in `chat`: each with a stretch of its text as last edited."
      ),
      inputSchema: z.strictObject({ q: z.string().min(1), chat: chatArg.optional(), limit: z.int().min(1).max(50).optional() })
    },
    async ({ q, chat, limit = PAGE }) => {
      const found = (await client.search(chat === undefined ? { q, limit } : { q, chat, limit })).filter((hit) => mayCome(hit.event)); // As the fold, which shows one an agent may not send nowhere.
      const entries = await trust(client, found);
      return data(entries.map((entry, index) => ({ ...noted(entry, me), ...(entry.trusted ? { snippet: (found[index]?.snippet ?? []).map((piece) => piece.text).join("") } : {}) })));
    }
  );

  server.registerTool(
    "job_status",
    {
      description: told("Where one job stands: an agent asked by a message. `request` is the message, `agent` the agent it tags. A state of answered comes with the answer."),
      inputSchema: z.strictObject({ request: noteArg, agent: agentArg })
    },
    async ({ request, agent }) => {
      const found = await readNote(client, request);
      const job = found?.jobs.find((each) => each.owner === agent.owner && each.repo === agent.repo);
      if (found === null || job === undefined) {
        throw new PlayerTwoError(`there is no request of ${agent.owner}/${agent.repo} with that id that you can see`);
      }
      const answer = found.answers.findLast((each) => each.agent === agent.repo && ownerOf(each.entry.event.author) === agent.owner);
      return data({ agent: `${agent.owner}/${agent.repo}`, state: job.state, answer: job.state === "answered" && answer !== undefined ? noted(answer.entry, me, answer) : null });
    }
  );

  if (allowSend) {
    sendingTools(server, client);
  }
  if (job !== null) {
    askingTool(server, client, job);
  }
  return server;
}
