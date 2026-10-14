/**
 * The MCP server, `player-two mcp`: the chat as tools for an agent in its owner's editor, which starts it and talks to it over standard input and output.
 * It runs as the person who joined from this machine, with their key, and talks to the hub as the command does. Reading only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ChatLog, chatOf, ONLINE } from "../core/chat.ts";
import type { Entry, Message } from "../core/chat.ts";
import { readContent } from "../core/kinds.ts";
import { noteLink, noteOf } from "../core/links.ts";
import { VERSION } from "../core/version.ts";
import { addressSchema } from "../core/wire.ts";
import { PlayerTwoError } from "../desk/client.ts";
import type { Client } from "../desk/client.ts";
import { agentOf, chatFrom, glance, readNote, trust } from "../desk/notes.ts";

const PAGE = 20; // Events `read_chat` and `search` give when not told how many.
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
    author: event.author,
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

/** The server for one person. */
export function createServer(client: Client): McpServer {
  const me = client.config.name;
  const server = new McpServer({ name: "player-two", version: VERSION });

  server.registerTool("whoami", { description: "Your name on Player Two, the hub you are on, and the repos you share with the branch each is on.", inputSchema: z.strictObject({}) }, async () => {
    const team = await client.repos();
    return data({ name: me, hub: client.config.hub, repos: team.filter((repo) => repo.user === me).map((repo) => ({ repo: repo.name, branch: repo.branch })) });
  });

  server.registerTool(
    "list_chats",
    { description: "The channels you are in and the people on the hub, each with the count of unread messages and answers since you last read it in your window.", inputSchema: z.strictObject({}) },
    async () => {
      const { rows } = await glance(client, readMarks(client.home));
      return data(rows);
    }
  );

  server.registerTool(
    "list_agents",
    {
      description:
        "Every agent anyone can ask, as person/repo: a person's checkout of a repo, with the branch it is on and whether its owner is here now. `query` keeps those whose person/repo contains it.",
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
      description:
        "A page of one chat, oldest first: its messages and agents' answers as they read now. Pass the `before` an answer gives to read the page before it; it is null when there is nothing further back.",
      inputSchema: z.strictObject({ chat: chatArg, before: z.int().min(1).optional(), limit: z.int().min(1).max(50).optional() })
    },
    async ({ chat, before, limit = PAGE }) => data(await readChat(client, chat, before, limit))
  );

  server.registerTool(
    "read_note",
    {
      description: "One note, a message or an agent's answer, by its link or id, as it reads now: with where each agent it tags stands, their answers, and the replies in its thread.",
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
      description:
        "The messages and agents' answers you can see that hold every word of `q` (at most 8 words), best match first, in every chat or in `chat`: each with a stretch of its text as last edited.",
      inputSchema: z.strictObject({ q: z.string().min(1), chat: chatArg.optional(), limit: z.int().min(1).max(50).optional() })
    },
    async ({ q, chat, limit = PAGE }) => {
      const found = await client.search(chat === undefined ? { q, limit } : { q, chat, limit });
      const entries = await trust(client, found);
      return data(entries.map((entry, index) => ({ ...noted(entry, me), ...(entry.trusted ? { snippet: (found[index]?.snippet ?? []).map((piece) => piece.text).join("") } : {}) })));
    }
  );

  server.registerTool(
    "job_status",
    {
      description: "Where one job stands: an agent asked by a message. `request` is the message, `agent` the agent it tags. A state of answered comes with the answer.",
      inputSchema: z.strictObject({ request: noteArg, agent: agentArg })
    },
    async ({ request, agent }) => {
      const found = await readNote(client, request);
      const job = found?.jobs.find((each) => each.owner === agent.owner && each.repo === agent.repo);
      if (found === null || job === undefined) {
        throw new PlayerTwoError(`there is no request of ${agent.owner}/${agent.repo} with that id that you can see`);
      }
      const answer = found.answers.findLast((each) => each.agent === agent.repo && each.entry.event.author === agent.owner);
      return data({ agent: `${agent.owner}/${agent.repo}`, state: job.state, answer: job.state === "answered" && answer !== undefined ? noted(answer.entry, me, answer) : null });
    }
  );

  return server;
}
