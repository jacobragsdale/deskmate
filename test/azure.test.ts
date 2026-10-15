/**
 * Azure DevOps: finding a token, with a git credential helper of the test's own, and every call against a small fake of its routes in this process.
 * The fake answers with test/fixtures/azure: Microsoft's own samples for REST 7.1 where its pages give one (Repositories - Get, Pull Requests - Get Pull Requests
 * and Create, whose pull request also stands for Get Pull Request, which has none), and a build written from the documented Build where Builds - List gives none.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { parseRemote } from "../src/core/remotes.ts";
import type { RepoRef } from "../src/core/wire.ts";
import { Azure, AZURE, azureBase, findToken, gitPassword } from "../src/desk/azure.ts";
import { defaultHome } from "../src/desk/client.ts";
import { basic, fakeAzure, json, refusal, SIGN_IN } from "./fakeAzure.ts";
import type { Call, Reply } from "./fakeAzure.ts";

const REPO_URL = "https://dev.azure.com/acme/Platform/_git/uploader";
const OAUTH = "an-oauth-token"; // What Git Credential Manager keeps for Azure DevOps.
const PAT = "a-personal-access-token";
const LET_IN = new Set([basic(PAT), `Bearer ${OAUTH}`]); // A personal access token goes in as Basic; an OAuth token only as Bearer.
const REPO_API = "/acme/platform/_apis/git/repositories/uploader";
const BUILDS_API = "/acme/platform/_apis/build/builds";
const REPO_ID = "5febef5a-833d-4e14-b9c0-14cb638f91e6"; // As repository.json gives it.

/** What Azure DevOps would answer, for the routes azure.ts calls; null for the repo named "slow", which is never answered. */
function answer(call: Call): Reply | null {
  if (call.query.get("api-version") !== "7.1") {
    return refusal(400, "VS800006: No api-version was supplied for the GET request.");
  }
  if (!LET_IN.has(call.authorization)) {
    return SIGN_IN;
  }
  switch (`${call.method} ${call.path}`) {
    case `GET ${REPO_API}`:
      return json("repository.json");
    case `GET ${REPO_API}/pullrequests/20`:
      return json("pull-request.json");
    case `GET ${REPO_API}/pullrequests`:
      return json("pull-requests.json");
    case `POST ${REPO_API}/pullrequests`:
      return call.body.includes('"refs/heads/taken"') ? refusal(409, "TF401179: An active pull request for the source and target branch already exists.") : json("created-pull-request.json", 201);
    case `GET ${BUILDS_API}`:
      return call.query.get("branchName") === "refs/heads/npaulk/my_work" ? json("builds.json") : { status: 200, type: "application/json", body: JSON.stringify({ count: 0, value: [] }) };
    case "GET /acme/platform/_apis/git/repositories/slow":
      return null;
    default:
      return refusal(404, "TF401019: The Git repository with name or identifier missing does not exist or you do not have permissions for the operation you are attempting.");
  }
}

function repo(name: string): RepoRef {
  const remote = parseRemote(`https://dev.azure.com/acme/Platform/_git/${name}`);
  assert.ok(remote !== null);
  return remote;
}

/** A folder for one test, where git's configuration and the identity's folder are moved, so no credential helper of whoever runs the tests is ever asked. */
function isolate(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "player-two-azure-"));
  writeFileSync(join(dir, "gitconfig"), "");
  process.env["GIT_CONFIG_GLOBAL"] = join(dir, "gitconfig");
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.env["PLAYER_TWO_HOME"] = join(dir, "home");
  for (const variable of ["AZURE_DEVOPS_EXT_PAT", "GIT_ASKPASS", "SSH_ASKPASS", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
    Reflect.deleteProperty(process.env, variable);
  }
  t.after(() => {
    Reflect.deleteProperty(process.env, "AZURE_DEVOPS_EXT_PAT");
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Make git's one credential helper a script that runs `body` when asked for a credential, with what git asked on its standard input. */
function useHelper(dir: string, body: string): void {
  const helper = join(dir, "helper");
  writeFileSync(helper, `#!/bin/sh\ntest "$1" = get || exit 0\n${body}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "gitconfig"), `[credential]\n\thelper = ${helper}\n`);
}

await test("git's credential helper is asked for the repo's address, and the password it gives taken", async (t) => {
  useHelper(isolate(t), `grep -qx 'host=dev.azure.com' && printf 'protocol=https\\nhost=dev.azure.com\\nusername=jacob@example.com\\npassword=${OAUTH}\\n'`);
  assert.equal(await gitPassword(REPO_URL), OAUTH);
  assert.equal(await gitPassword("https://example.com/acme/uploader"), null);
});

await test("nothing may ask the user: with no helper, git neither prompts nor runs an askpass program, from the environment or its configuration", async (t) => {
  const dir = isolate(t);
  const asked = join(dir, "asked");
  const askpass = join(dir, "askpass");
  writeFileSync(askpass, `#!/bin/sh\ntouch '${asked}'\necho from-askpass\n`, { mode: 0o755 });
  writeFileSync(join(dir, "gitconfig"), `[core]\n\taskPass = ${askpass}\n`);
  process.env["GIT_ASKPASS"] = askpass;
  process.env["SSH_ASKPASS"] = askpass;
  t.after(() => {
    Reflect.deleteProperty(process.env, "GIT_ASKPASS");
    Reflect.deleteProperty(process.env, "SSH_ASKPASS");
  });
  assert.equal(await gitPassword(REPO_URL), null);
  assert.equal(existsSync(asked), false);
});

await test("a helper that has not answered within the limit is ended with git, and no password found", async (t) => {
  useHelper(isolate(t), "sleep 30");
  const began = Date.now();
  assert.equal(await gitPassword(REPO_URL, 0.3), null);
  assert.ok(Date.now() - began < 5000, `took ${String(Date.now() - began)} ms`);
});

await test("a token is looked for in the environment, then in azure.json in the identity's folder, then from git", async (t) => {
  const dir = isolate(t);
  const home = defaultHome();
  const saved = join(home, "azure.json");
  useHelper(dir, `printf 'username=jacob@example.com\\npassword=${OAUTH}\\n'`);
  assert.deepEqual(await findToken(home, REPO_URL), { secret: OAUTH, source: "git's credential helper" });

  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(saved, JSON.stringify({ token: "a-saved-pat" }), { mode: 0o600 });
  assert.deepEqual(await findToken(home, REPO_URL), { secret: "a-saved-pat", source: saved });

  process.env["AZURE_DEVOPS_EXT_PAT"] = "a-pat-from-the-environment";
  t.after(() => {
    Reflect.deleteProperty(process.env, "AZURE_DEVOPS_EXT_PAT");
  });
  assert.deepEqual(await findToken(home, REPO_URL), { secret: "a-pat-from-the-environment", source: "AZURE_DEVOPS_EXT_PAT" });

  // With none of the three, there is no token; a file not as the setup page writes one is not one.
  Reflect.deleteProperty(process.env, "AZURE_DEVOPS_EXT_PAT");
  writeFileSync(saved, "a-pat-with-no-json-around-it");
  writeFileSync(join(dir, "gitconfig"), "");
  assert.equal(await findToken(home, REPO_URL), null);
});

await test("each call is read from the answer Microsoft documents for it, and asks with api-version 7.1 for what the plan names", async (t) => {
  isolate(t);
  process.env["AZURE_DEVOPS_EXT_PAT"] = PAT;
  const fake = await fakeAzure(t, answer);
  const azure = new Azure(defaultHome(), fake.base);
  const uploader = repo("uploader");

  assert.deepEqual(await azure.repository(uploader), { ok: true, data: { id: REPO_ID, defaultBranch: "master", web: REPO_URL } });
  assert.deepEqual(await azure.pullRequest(uploader, 20), {
    ok: true,
    data: {
      id: 20,
      title: "Updated pull request title",
      status: "completed",
      draft: false,
      source: "npaulk/my_work",
      target: "new_feature",
      creator: "Normal Paulk",
      reviewers: [{ name: "Normal Paulk", vote: 10 }],
      web: `${REPO_URL}/pullrequest/20`
    }
  });
  const fromBranch = await azure.pullRequestsFor(uploader, "npaulk/my_work");
  assert.ok(fromBranch.ok);
  assert.deepEqual(
    fromBranch.data.map((pr) => [pr.id, pr.status, pr.source, pr.target, pr.web]),
    [
      [22, "active", "npaulk/my_work", "new_feature", `${REPO_URL}/pullrequest/22`],
      [21, "active", "npaulk/known_issues", "new_feature", `${REPO_URL}/pullrequest/21`],
      [1, "active", "some_branch", "master", `${REPO_URL}/pullrequest/1`]
    ]
  );
  assert.deepEqual(fromBranch.data[2]?.reviewers, [{ name: "[2016_10_31]\\2016_10_31 Team", vote: 0 }]);
  assert.deepEqual(await azure.latestBuild(uploader, "npaulk/my_work"), {
    ok: true,
    data: { id: 391, name: "AnotherRepository-CI", status: "completed", result: "failed", web: "https://dev.azure.com/acme/Platform/_build/results?buildId=391" }
  });
  assert.deepEqual(await azure.latestBuild(uploader, "quiet"), { ok: true, data: null });
  const created = await azure.createPullRequest(uploader, { source: "npaulk/my_work", target: "new_feature", title: "A new feature", description: "Adding a new feature", draft: true });
  assert.ok(created.ok);
  assert.deepEqual([created.data.id, created.data.status, created.data.draft, created.data.web], [22, "active", false, `${REPO_URL}/pullrequest/22`]);

  const version = { "api-version": "7.1" };
  const builds = (branch: string): Record<string, string> => ({
    repositoryId: REPO_ID,
    repositoryType: "TfsGit",
    branchName: `refs/heads/${branch}`,
    $top: "1",
    queryOrder: "queueTimeDescending",
    ...version
  });
  assert.deepEqual(
    fake.calls.map((call) => [call.method, call.path, Object.fromEntries(call.query)]),
    [
      ["GET", REPO_API, version],
      ["GET", `${REPO_API}/pullrequests/20`, version],
      ["GET", `${REPO_API}/pullrequests`, { "searchCriteria.sourceRefName": "refs/heads/npaulk/my_work", "searchCriteria.status": "all", $top: "5", ...version }],
      ["GET", REPO_API, version],
      ["GET", BUILDS_API, builds("npaulk/my_work")],
      ["GET", REPO_API, version],
      ["GET", BUILDS_API, builds("quiet")],
      ["POST", `${REPO_API}/pullrequests`, version]
    ]
  );
  assert.deepEqual(JSON.parse(fake.calls.at(-1)?.body ?? ""), {
    sourceRefName: "refs/heads/npaulk/my_work",
    targetRefName: "refs/heads/new_feature",
    title: "A new feature",
    description: "Adding a new feature",
    isDraft: true
  });
  assert.ok(fake.calls.every((call) => call.authorization === basic(PAT)));
});

await test("a sign-in page in place of an answer is not being signed in, and a token from git gets in as Bearer, which is then kept", async (t) => {
  const dir = isolate(t);
  const fake = await fakeAzure(t, answer);
  const uploader = repo("uploader");
  const azure = new Azure(defaultHome(), fake.base);

  process.env["AZURE_DEVOPS_EXT_PAT"] = "an-expired-pat";
  assert.deepEqual(await azure.repository(uploader), { ok: false, problem: "not signed in to Azure DevOps: the token from AZURE_DEVOPS_EXT_PAT was not accepted" });
  assert.equal(fake.calls.length, 1); // A token from the environment is never tried as Bearer.

  Reflect.deleteProperty(process.env, "AZURE_DEVOPS_EXT_PAT");
  useHelper(dir, `printf 'username=jacob@example.com\\npassword=${OAUTH}\\n'`);
  assert.equal((await azure.repository(uploader)).ok, true);
  assert.equal((await azure.pullRequest(uploader, 20)).ok, true);
  assert.deepEqual(
    fake.calls.slice(1).map((call) => call.authorization.split(" ")[0]),
    ["Basic", "Bearer", "Bearer"]
  );

  writeFileSync(join(dir, "gitconfig"), "");
  assert.deepEqual(await new Azure(defaultHome(), fake.base).repository(uploader), {
    ok: false,
    problem: "no Azure DevOps token: set AZURE_DEVOPS_EXT_PAT, save one on the setup page, or sign in to dev.azure.com with git's credential helper"
  });
});

await test("a 404 says which repository or pull request was not found, and any other refusal carries Azure's own words", async (t) => {
  isolate(t);
  process.env["AZURE_DEVOPS_EXT_PAT"] = PAT;
  const fake = await fakeAzure(t, answer);
  const azure = new Azure(defaultHome(), fake.base);
  const uploader = repo("uploader");

  assert.deepEqual(await azure.repository(repo("missing")), { ok: false, problem: "Azure DevOps has no repository missing, or the token cannot see it" });
  assert.deepEqual(await azure.pullRequest(uploader, 999), { ok: false, problem: "Azure DevOps has no pull request 999 in uploader, or the token cannot see it" });
  assert.deepEqual(await azure.createPullRequest(uploader, { source: "taken", target: "master", title: "Again", description: "", draft: false }), {
    ok: false,
    problem: "Azure DevOps answered 409: TF401179: An active pull request for the source and target branch already exists."
  });
  const elsewhere = parseRemote("https://github.com/acme/uploader");
  assert.ok(elsewhere !== null);
  assert.deepEqual(await azure.repository(elsewhere), { ok: false, problem: "uploader is not on Azure DevOps" });
});

await test("an answer that does not come in time is given up on", async (t) => {
  isolate(t);
  process.env["AZURE_DEVOPS_EXT_PAT"] = PAT;
  const fake = await fakeAzure(t, answer);
  const began = Date.now();
  assert.deepEqual(await new Azure(defaultHome(), fake.base, 0.3).repository(repo("slow")), { ok: false, problem: "Azure DevOps did not answer within 0.3 seconds" });
  assert.ok(Date.now() - began < 5000, `took ${String(Date.now() - began)} ms`);
});

await test("the smoke test's address for Azure DevOps is taken only when it is a port on this machine's loopback address, so a stray one sends a token nowhere", () => {
  const at = (value: string): string => azureBase({ PLAYER_TWO_TEST_AZURE: value });
  assert.equal(azureBase({}), AZURE);
  assert.equal(at("http://127.0.0.1:43123"), "http://127.0.0.1:43123");
  for (const elsewhere of [
    "https://example.com",
    "http://127.0.0.1.example.com:80",
    "http://localhost:43123",
    "http://127.0.0.1:43123/",
    "http://user@127.0.0.1:1",
    "http://10.0.0.1:80",
    " http://127.0.0.1:1",
    ""
  ]) {
    assert.equal(at(elsewhere), AZURE, elsewhere);
  }
});
