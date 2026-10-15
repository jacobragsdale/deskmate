/** The setup check against a real hub in this process, and Azure DevOps faked in it too: a machine where everything is in place, then one thing wrong at a time. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { publicHex } from "../src/core/sign.ts";
import { agentKey, agentKeyFile } from "../src/desk/agentKeys.ts";
import { saveToken } from "../src/desk/azure.ts";
import { http, loadClient } from "../src/desk/client.ts";
import { permissionTests, runChecks, testPermissions } from "../src/desk/doctor.ts";
import type { Check } from "../src/shared/ipc.ts";
import { startHub, TEAM_REPOS } from "./startHub.ts";

const IDS = ["node", "identity", "hub", "proxy", "protocol", "clock", "dev", "repos", "agent-keys", "git", "git-auth", "azure", "agent"];
const PAT = "a-personal-access-token";
const GIVE_TOKEN =
  "Give Player Two an Azure DevOps token in one of three ways: export AZURE_DEVOPS_EXT_PAT in ~/.profile, inside WSL on Windows; save one below, which keeps it in azure.json, readable only by you; or sign in to dev.azure.com once with git, whose credential helper keeps it. A personal access token needs the scopes Code (read and write) and Build (read)";

// git's configuration of the test's own, so no credential helper of whoever runs the tests is asked for a token.
const gitHome = mkdtempSync(join(tmpdir(), "player-two-doctor-"));
writeFileSync(join(gitHome, "gitconfig"), "");
process.env["GIT_CONFIG_GLOBAL"] = join(gitHome, "gitconfig");
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
Reflect.deleteProperty(process.env, "AZURE_DEVOPS_EXT_PAT");
process.on("exit", () => {
  rmSync(gitHome, { recursive: true, force: true });
});

// Azure DevOps as far as the setup check asks it: the uploader repository, as Microsoft's sample has one, for PAT; anything else gets the sign-in page Azure answers with.
const azure = createHttpServer((request, response) => {
  const known = request.headers.authorization === `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`;
  if (known && request.url?.startsWith("/acme/platform/_apis/git/repositories/uploader?") === true) {
    response.writeHead(200, { "Content-Type": "application/json" }).end(readFileSync(join(import.meta.dirname, "fixtures", "azure", "repository.json")));
  } else {
    response.writeHead(203, { "Content-Type": "text/html" }).end("<html><body>Sign in to your account</body></html>");
  }
});
azure.listen(0, "127.0.0.1").unref();
await once(azure, "listening");
const azureAddress = azure.address();
assert.ok(azureAddress !== null && typeof azureAddress === "object");
const AZURE_BASE = `http://127.0.0.1:${String(azureAddress.port)}`;

/** Every check, with Azure DevOps the fake above. */
function check(home: string, dev: string): Promise<Check[]> {
  return runChecks(home, dev, undefined, AZURE_BASE);
}

interface Machine {
  readonly home: string;
  readonly dev: string;
}

/**
 * A machine that has joined a hub whose clock is `skew` seconds ahead of this one: its agent command on the PATH, a checkout of a team repo
 * whose origin git is told to find in a bare repository on disk, so asking the remote needs no network and no credentials, with its agent's key told to the hub as the desk tells it,
 * and a token Azure DevOps takes, saved as the setup page saves one.
 */
async function machine(t: TestContext, skew = 0): Promise<Machine> {
  const hub = await startHub(t, () => Date.now() / 1000 + skew);
  const alice = await hub.join("alice"); // Its agent command is "fake-agent".
  await alice.publish("*", "agent.register", { repo: "uploader", pubkey: publicHex(agentKey(join(hub.dir, "alice"), "uploader")) });
  const tools = join(hub.dir, "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, "fake-agent"), "#!/bin/sh\n", { mode: 0o755 });
  const path = process.env["PATH"];
  process.env["PATH"] = `${tools}:${path ?? ""}`;
  for (const variable of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
    Reflect.deleteProperty(process.env, variable); // The hub is on this machine; a proxy set where the tests run would only get in the way.
  }
  t.after(() => {
    process.env["PATH"] = path;
  });
  const dev = join(hub.dir, "dev");
  const remote = `${TEAM_REPOS}Platform/_git/uploader`;
  const git = (...args: string[]): void => {
    execFileSync("git", args, { stdio: "ignore" });
  };
  git("init", "-q", "--bare", join(hub.dir, "uploader.git"));
  git("init", "-q", join(dev, "uploader"));
  git("-C", join(dev, "uploader"), "remote", "add", "origin", remote);
  git("-C", join(dev, "uploader"), "config", `url.${join(hub.dir, "uploader.git")}.insteadOf`, remote);
  saveToken(join(hub.dir, "alice"), PAT);
  return { home: join(hub.dir, "alice"), dev };
}

function statuses(checks: readonly Check[]): Record<string, string> {
  return Object.fromEntries(checks.map((check) => [check.id, check.status]));
}

await test("on a machine with everything in place every check passes, in order", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t);
  const checks = await check(home, dev);
  assert.deepEqual(
    checks.map((check) => check.id),
    IDS
  );
  assert.deepEqual(statuses(checks), Object.fromEntries(IDS.map((id) => [id, "ok"])), JSON.stringify(checks, null, 1));
  assert.ok(checks.every((check) => check.fix === ""));
});

await test("a hub clock 400 seconds ahead fails the clock, and the hub is not asked what it would refuse", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t, 400);
  const checks = await check(home, dev);
  const clock = checks.find((check) => check.id === "clock");
  assert.equal(clock?.status, "fail");
  assert.match(clock.detail, /^this clock is (399|40[01]) seconds behind the hub's, so the hub refuses this machine's signatures$/);
  assert.notEqual(clock.fix, "");
  assert.deepEqual(statuses(checks), { ...Object.fromEntries(IDS.map((id) => [id, "ok"])), clock: "fail", protocol: "skip", repos: "skip", "agent-keys": "skip", "git-auth": "skip", azure: "skip" });
});

await test("a missing key fails the identity", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t);
  rmSync(join(home, "key"));
  const checks = await check(home, dev);
  assert.deepEqual(
    checks.find((check) => check.id === "identity"),
    { id: "identity", title: "This machine has joined a hub", status: "fail", detail: `not joined: there is no key in ${home}`, fix: "Join from the window, or run: player-two join HUB NAME TOKEN" }
  );
  assert.equal(statuses(checks)["protocol"], "skip"); // Asking /info takes a signature, and there is no key to make one.
});

await test("an agent key that is missing, readable by others, or not the one the hub has for the agent fails agent-keys, saying what fixes it", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t);
  const file = agentKeyFile(home, "uploader");
  const agentKeys = async (): Promise<Check | undefined> => (await check(home, dev)).find((check) => check.id === "agent-keys");
  const title = "Each shared repo's agent has its own key, and the hub has it";
  const again = "Quit Player Two and open it again: when it shares a repo, it makes the repo's agent a key if it has none, and tells the hub the key";
  assert.deepEqual(await agentKeys(), { id: "agent-keys", title, status: "ok", detail: "uploader", fix: "" });

  chmodSync(file, 0o640);
  assert.deepEqual(await agentKeys(), { id: "agent-keys", title, status: "fail", detail: `${file} can be read by others: its mode is 640`, fix: `chmod 600 '${file}'` });
  chmodSync(file, 0o600);

  rmSync(file); // A new key, which the hub has never been told.
  agentKey(home, "uploader");
  assert.deepEqual(await agentKeys(), { id: "agent-keys", title, status: "fail", detail: `the hub has another key for your uploader agent than the one in ${file}`, fix: again });

  rmSync(file);
  assert.deepEqual(await agentKeys(), { id: "agent-keys", title, status: "fail", detail: `your uploader agent has no key: there is no ${file}`, fix: again });
});

await test(
  "Azure DevOps lets in the token saved on the setup page; without a token, or with one it refuses, the check fails and says how to give one; a hub whose repos are elsewhere skips it",
  { timeout: 60_000 },
  async (t) => {
    const { home, dev } = await machine(t);
    const file = join(home, "azure.json");
    const azureCheck = async (where = home, repos = dev): Promise<Check | undefined> => (await check(where, repos)).find((each) => each.id === "azure");
    const title = "Azure DevOps answers to your token";
    assert.deepEqual(await azureCheck(), { id: "azure", title, status: "ok", detail: `Azure DevOps let the token from ${file} look up uploader`, fix: "" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { token: PAT });

    saveToken(home, "  an-old-token\n"); // Pasted with spaces around it, which are not part of it.
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { token: "an-old-token" });
    assert.deepEqual(await azureCheck(), { id: "azure", title, status: "fail", detail: `not signed in to Azure DevOps: the token from ${file} was not accepted`, fix: GIVE_TOKEN });
    assert.throws(() => {
      saveToken(home, "two words");
    }, /^Error: a token is one word, with no spaces in it: nothing was saved$/);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { token: "an-old-token" });

    rmSync(file);
    assert.deepEqual(await azureCheck(), { id: "azure", title, status: "fail", detail: "no Azure DevOps token was found", fix: GIVE_TOKEN });

    const elsewhere = await startHub(t, () => Date.now() / 1000, "", "https://github.com/acme/");
    await elsewhere.join("bob");
    assert.deepEqual(await azureCheck(join(elsewhere.dir, "bob"), join(elsewhere.dir, "dev")), {
      id: "azure",
      title,
      status: "skip",
      detail: "the team's repos are under github.com/acme, not on Azure DevOps",
      fix: ""
    });
  }
);

await test("an unreachable hub fails the hub, and the checks that need its answer are skipped", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t);
  const gone = createServer().listen(0, "127.0.0.1"); // A port nothing listens on once this has let it go.
  await once(gone, "listening");
  const address = gone.address();
  assert.ok(address !== null && typeof address === "object");
  gone.close();
  const hub = `http://127.0.0.1:${String(address.port)}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ hub, name: "alice", agent: "fake-agent" }));
  const checks = await check(home, dev);
  assert.equal(checks.find((check) => check.id === "hub")?.detail, `cannot reach ${hub}: connect ECONNREFUSED 127.0.0.1:${String(address.port)}`);
  assert.deepEqual(statuses(checks), {
    ...Object.fromEntries(IDS.map((id) => [id, "ok"])),
    hub: "fail",
    protocol: "skip",
    clock: "skip",
    repos: "skip",
    "agent-keys": "skip",
    "git-auth": "skip",
    azure: "skip"
  });
});

await test("each agent over ACP is started and asked to open a session, and fails with its own words, or with how to sign in when that is what it needs", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t);
  const client = loadClient(home, http, () => Date.now() / 1000);
  assert.ok(client !== null);
  const fake = { label: "Fake", protocol: "acp", command: process.execPath, args: [join(import.meta.dirname, "fixtures", "fake-acp-agent.ts")] } as const;
  client.saveAgents(
    [
      ...client.config.agents,
      { ...fake, id: "fake" },
      { ...fake, id: "signed-out", label: "Signed out", args: [...fake.args, "--signed-out"] },
      { ...fake, id: "broken", label: "Broken", args: ["--no-such-flag-for-node"] }
    ],
    client.config.defaultAgent
  );
  const checks = await check(home, dev);
  assert.deepEqual(
    checks.filter((check) => check.id.startsWith("agent-acp:")),
    [
      { id: "agent-acp:fake", title: "Fake starts and speaks ACP", status: "ok", detail: "Fake answers over ACP, version 1.2.3", fix: "" },
      {
        id: "agent-acp:signed-out",
        title: "Signed out starts and speaks ACP",
        status: "fail",
        detail: "Signed out is not signed in. Sign in once in a terminal where your repos are, inside WSL on Windows, with Signed out's own sign-in, then try again",
        fix: "Signed out's own sign-in"
      },
      { id: "agent-acp:broken", title: "Broken starts and speaks ACP", status: "fail", detail: `Broken ended with status 9: ${process.execPath}: bad option: --no-such-flag-for-node`, fix: "" }
    ]
  );
  assert.deepEqual(
    checks.map((check) => check.id),
    [...IDS, "agent-acp:fake", "agent-permissions:fake", "agent-acp:signed-out", "agent-permissions:signed-out", "agent-acp:broken", "agent-permissions:broken"]
  );
  assert.deepEqual(
    checks.find((check) => check.id === "agent-permissions:fake"),
    {
      id: "agent-permissions:fake",
      title: "Fake asks before it writes a file",
      status: "skip",
      detail: "not tested yet: Test permissions asks it to write a file and refuses, which costs a model call",
      fix: ""
    }
  ); // The setup check never runs it: it costs a model call.
});

await test(
  "the permission test passes an agent that asks before it writes a file and writes none when refused, fails one that writes without asking, and saves each with the agent's version",
  { timeout: 60_000 },
  async (t) => {
    const { home, dev } = await machine(t);
    const client = loadClient(home, http, () => Date.now() / 1000);
    assert.ok(client !== null);
    const script = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");
    const asking = { id: "fake", label: "Fake", protocol: "acp", command: process.execPath, args: [script, "--no-pids"] } as const;
    const careless = { ...asking, id: "careless", label: "Careless", args: [script, "--no-pids", "--no-asking"] };
    client.saveAgents([...client.config.agents, asking, careless], client.config.defaultAgent);
    const never = new AbortController().signal;

    assert.deepEqual(await testPermissions(home, asking, never), {
      id: "agent-permissions:fake",
      title: "Fake asks before it writes a file",
      status: "ok",
      detail: "it asked before it wrote a file, and wrote none when refused, at version 1.2.3",
      fix: ""
    });
    const refused = "it wrote edited.txt without asking when tested at version 1.2.3, so it is treated as an agent that cannot be limited, and runs only with full access";
    assert.deepEqual(await testPermissions(home, careless, never), { id: "agent-permissions:careless", title: "Careless asks before it writes a file", status: "fail", detail: refused, fix: "" });
    assert.deepEqual(permissionTests(home), {
      [`${process.execPath} ${script} --no-pids`]: { version: "1.2.3", passed: true, detail: "asked before it wrote a file, and wrote none when refused" },
      [`${process.execPath} ${script} --no-pids --no-asking`]: { version: "1.2.3", passed: false, detail: "wrote edited.txt without asking" }
    });

    // The setup check shows what was saved; a version other than the one tested is worth testing again.
    const statusOf = async (): Promise<string[]> => (await check(home, dev)).filter((check) => check.id.startsWith("agent-permissions:")).map((check) => `${check.id} ${check.status}`);
    assert.deepEqual(await statusOf(), ["agent-permissions:fake ok", "agent-permissions:careless fail"]);
    const file = join(home, "agent-permissions.json");
    writeFileSync(file, readFileSync(file, "utf8").replaceAll('"1.2.3"', '"1.0.0"'));
    assert.deepEqual(await statusOf(), ["agent-permissions:fake warn", "agent-permissions:careless fail"]);
  }
);
