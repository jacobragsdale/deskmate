/**
 * A small fake of Azure DevOps's REST routes, in the test's own process on a port of its own, which keeps every request it is sent and answers each as the test says, from the responses
 * Microsoft documents in test/fixtures/azure: Microsoft's own samples for REST 7.1 where its pages give one, and a build written from the documented Build where Builds - List gives none.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { z } from "zod";

/** A request the fake was sent. */
export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string;
  readonly body: string;
}

/** What the fake answers a request with. */
export interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string;
}

export interface Fake {
  readonly base: string;
  readonly calls: Call[];
}

export function basic(secret: string): string {
  return `Basic ${Buffer.from(`:${secret}`).toString("base64")}`;
}

export function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", "azure", name), "utf8");
}

/** A fixture as a JSON answer. */
export function json(name: string, status = 200): Reply {
  return { status, type: "application/json; charset=utf-8", body: fixture(name) };
}

/** Azure DevOps refusing a request: its own shape for one, with its message. */
export function refusal(status: number, message: string): Reply {
  return {
    status,
    type: "application/json; charset=utf-8",
    body: JSON.stringify({ $id: "1", innerException: null, message, typeName: "Microsoft.TeamFoundation.Git.Server.GitException", typeKey: "GitException", errorCode: 0, eventId: 3000 })
  };
}

/** The sign-in page Azure DevOps answers a request it does not let in with, as 203. */
export const SIGN_IN: Reply = { status: 203, type: "text/html; charset=utf-8", body: fixture("sign-in.html") };

/** The fake, answering each request as `answer` says, or never when it says null. */
export async function fakeAzure(t: TestContext, answer: (call: Call) => Reply | null): Promise<Fake> {
  const calls: Call[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://azure.test");
      const call = { method: request.method ?? "", path: url.pathname, query: url.searchParams, authorization: request.headers.authorization ?? "", body };
      calls.push(call);
      const reply = answer(call);
      if (reply !== null) {
        response.writeHead(reply.status, { "Content-Type": reply.type }).end(reply.body);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections(); // A request never answered, among them.
    server.close();
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { base: `http://127.0.0.1:${String(address.port)}`, calls };
}

const PROJECT = /^\/acme\/platform\/_apis\/(?:git\/repositories\/[^/]+(\/pullrequests(?:\/([0-9]+))?)?|build\/builds)$/;
const pullSchema = z.looseObject({ pullRequestId: z.int(), sourceRefName: z.string() });
const listSchema = z.object({ value: z.array(pullSchema) });
const madeSchema = z.object({ sourceRefName: z.string(), targetRefName: z.string(), title: z.string(), description: z.string(), isDraft: z.boolean() });
const buildSchema = z.object({ value: z.array(z.looseObject({})).length(1) });

/** The project the fake plays, as a test changes it: the result of every branch's latest build, null while it runs; and the pull requests made through it, newest last. */
export interface Project {
  result: string | null;
  readonly made: z.infer<typeof madeSchema>[];
}

/**
 * Azure DevOps as a team's would answer for every repo of acme's Platform project, letting in only `secret`: each repo is repository.json; its pull requests are those of
 * pull-requests.json and pull-request.json, each repo's alike, and those made since, numbered from 101, a list holding those from the branch it asks for; and every branch's latest
 * build is the one of builds.json, its result as `project.result` says. Anything else is a 404.
 */
export function platform(secret: string): { readonly project: Project; readonly answer: (call: Call) => Reply | null } {
  const state: Project = { result: "failed", made: [] };
  const fixed = [...listSchema.parse(JSON.parse(fixture("pull-requests.json"))).value, pullSchema.parse(JSON.parse(fixture("pull-request.json")))];
  const created = z.looseObject({}).parse(JSON.parse(fixture("created-pull-request.json")));
  const [build = {}] = buildSchema.parse(JSON.parse(fixture("builds.json"))).value;
  const answer = (call: Call): Reply | null => {
    const route = PROJECT.exec(call.path);
    if (call.query.get("api-version") !== "7.1") {
      return refusal(400, "VS800006: No api-version was supplied for the GET request.");
    }
    if (call.authorization !== basic(secret)) {
      return SIGN_IN;
    }
    const made = (pull: z.infer<typeof madeSchema>, at: number): z.infer<typeof pullSchema> => ({ ...created, ...pull, pullRequestId: 101 + at, status: "active" });
    const pulls = [...state.made.map(made).toReversed(), ...fixed]; // Newest first, as Azure DevOps lists them.
    const reply = (body: unknown, status = 200): Reply => ({ status, type: "application/json; charset=utf-8", body: JSON.stringify(body) });
    if (route === null) {
      return refusal(404, "TF401019: The Git repository with name or identifier missing does not exist or you do not have permissions for the operation you are attempting.");
    }
    if (call.path.endsWith("/build/builds")) {
      return reply({ count: 1, value: [{ ...build, ...(state.result === null ? { status: "inProgress", result: undefined } : { result: state.result }) }] });
    }
    const [, list, id] = route;
    if (list === undefined) {
      return json("repository.json");
    }
    if (id !== undefined) {
      const found = pulls.find((pull) => pull.pullRequestId === Number(id));
      return found === undefined ? refusal(404, `TF401180: The requested pull request was not found.`) : reply(found);
    }
    if (call.method === "POST") {
      const pull = madeSchema.parse(JSON.parse(call.body));
      state.made.push(pull);
      return reply(made(pull, state.made.length - 1), 201);
    }
    const value = pulls.filter((pull) => pull.sourceRefName === call.query.get("searchCriteria.sourceRefName"));
    return reply({ count: value.length, value });
  };
  return { project: state, answer };
}
