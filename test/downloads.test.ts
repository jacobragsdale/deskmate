/** What the hub serves a teammate who has nothing installed yet: the page, the files in its downloads folder, and the script that installs the command on Linux, which is run here for real. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { pack } from "../scripts/build-runtime.ts";
import { NOW, startHub } from "./startHub.ts";
import type { Hub } from "./startHub.ts";

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a program and resolve with how it ended and what it printed. Not spawnSync: the hub is in this process, and has to answer while the program runs. */
function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(command, args, { env, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout, stderr });
    });
  });
}

interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** Ask the hub with node:http, which sends the path exactly as given, ".." and all, and any Host header: fetch would tidy both away. */
function ask(hub: Hub, path: string, headers: Readonly<Record<string, string>> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port: new URL(hub.url).port, path, headers }, (response) => {
      text(response).then((body) => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
      }, reject);
    }).on("error", reject);
  });
}

/** A folder for one test, inside it a downloads folder holding a runtime around a stand-in for Node that says what it was asked, and a stand-in installer. */
function downloads(t: TestContext): { readonly dir: string; readonly folder: string } {
  const dir = mkdtempSync(join(tmpdir(), "player-two-it's downloads-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const folder = join(dir, "downloads");
  mkdirSync(join(folder, "sub"), { recursive: true });
  writeFileSync(join(dir, "node"), `#!/bin/sh\necho "node $*"\n`, { mode: 0o755 });
  writeFileSync(join(dir, "command.js"), "");
  pack(join(dir, "node"), join(dir, "command.js"), join(folder, "wsl-runtime.tar.gz"));
  writeFileSync(join(folder, "player-two-setup.exe"), "the installer");
  writeFileSync(join(folder, "sub", "inner.txt"), "secret");
  writeFileSync(join(folder, ".hidden"), "secret");
  writeFileSync(join(dir, "outside.txt"), "secret");
  return { dir, folder };
}

await test("without a downloads folder the hub serves nothing to install", async (t) => {
  const hub = await startHub(t);
  for (const path of ["/", "/install.sh", "/downloads/player-two-setup.exe"]) {
    assert.deepEqual([path, (await ask(hub, path)).status], [path, 404]);
  }
});

await test("a file is served by its plain name, and nothing else by any path at all", async (t) => {
  const { dir, folder } = downloads(t);
  const hub = await startHub(t, () => NOW, folder);

  const installer = await ask(hub, "/downloads/player-two-setup.exe");
  assert.deepEqual([installer.status, installer.body, installer.headers["content-disposition"]], [200, "the installer", 'attachment; filename="player-two-setup.exe"']);

  const tries = [
    "/downloads/",
    "/downloads/..",
    "/downloads/../outside.txt",
    "/downloads/..%2Foutside.txt",
    "/downloads/%2e%2e%2Foutside.txt",
    "/downloads/%2E%2E/outside.txt",
    "/downloads/..%5Coutside.txt",
    "/downloads/..\\outside.txt",
    "/downloads/sub",
    "/downloads/sub/inner.txt",
    "/downloads/sub%2Finner.txt",
    "/downloads/.hidden",
    "/downloads//etc/passwd",
    "/downloads/%2Fetc%2Fpasswd",
    `/downloads/${encodeURIComponent(join(dir, "outside.txt"))}`,
    `/downloads${join(dir, "outside.txt").replaceAll(" ", "%20")}`, // The space encoded, as node:http will not send one.
    "/downloads/nothing-here.exe"
  ];
  for (const path of tries) {
    const refused = await ask(hub, path);
    assert.deepEqual([path, refused.status, refused.body.includes("secret")], [path, 404, false]);
  }
});

await test("the page and the script carry the address the hub was reached by, and a host header with anything more is refused", async (t) => {
  const { folder } = downloads(t);
  const hub = await startHub(t, () => NOW, folder);

  // Behind an ingress that ended TLS, the page gives the https address.
  const page = await ask(hub, "/", { Host: "player-two.acme.internal", "X-Forwarded-Proto": "https" });
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  assert.equal(page.headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'");
  assert.ok(page.body.includes('<a href="/downloads/player-two-setup.exe">'));
  assert.ok(page.body.includes(":root { color-scheme: light dark; }")); // On the root, or a dark system shows a white page with a pale link.
  assert.ok(page.body.includes("<code>https://player-two.acme.internal</code>"));
  assert.ok(page.body.includes("<code>curl -fsSL https://player-two.acme.internal/install.sh | sh</code>"));
  const script = await ask(hub, "/install.sh", { Host: "hub.acme.internal:8787" });
  assert.ok(script.body.includes("\nhub='http://hub.acme.internal:8787'\n"));
  for (const answer of [page, script]) {
    assert.deepEqual([answer.headers["cache-control"], answer.headers["vary"]], ["no-store", "Host"]); // Each is made from its own request's Host, so no cache may share it.
  }

  for (const host of ["x'$(touch pwned)'", 'x"><script>alert(1)</script>', "x;reboot", "x y"]) {
    for (const path of ["/", "/install.sh"]) {
      const refused = await ask(hub, path, { Host: host });
      assert.deepEqual([host, path, refused.status, refused.body], [host, path, 400, JSON.stringify({ detail: "unsupported host header" })]);
    }
  }
});

await test("curl HUB/install.sh | sh installs the command from the hub, and an archive that is not the one named installs nothing", { timeout: 30_000 }, async (t) => {
  const { dir, folder } = downloads(t);
  const hub = await startHub(t, () => NOW, folder);
  const install = (home: string): Promise<Ran> => {
    mkdirSync(home);
    // A PATH where no player-two is found yet, as on a machine that has never had one.
    return run("sh", ["-c", 'curl -fsSL "$0/install.sh" | sh', hub.url], { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: join(dir, "tmp") });
  };
  mkdirSync(join(dir, "tmp"));

  const home = join(dir, "home");
  const installed = await install(home);
  assert.deepEqual(installed, {
    code: 0,
    stdout: `Installed player-two. Join with: player-two join ${hub.url} YOUR-NAME THE-JOIN-TOKEN\n~/.local/bin is not on your PATH yet: open a new terminal, or add it.\n`,
    stderr: ""
  });
  const said = await run(join(home, ".local", "bin", "player-two"), ["--help"]);
  assert.match(said.stdout, /^node --use-env-proxy --use-system-ca \S.*\/\.player-two\/runtime\/sha256-[0-9a-f]{64}\/bin\/\.\.\/lib\/player-two\.js --help\n$/);
  assert.deepEqual(readdirSync(join(dir, "tmp")), []); // The download went in a folder of its own, which is gone.

  // The hub names a digest the archive does not have: the script stops before anything is put in place.
  writeFileSync(join(folder, "wsl-runtime.tar.gz.sha256"), `${"0".repeat(64)}  wsl-runtime.tar.gz\n`);
  const damaged = await install(join(dir, "another home"));
  assert.equal(damaged.code, 1);
  assert.match(damaged.stderr, /^the runtime archive wsl-runtime\.tar\.gz is damaged: its SHA-256 is [0-9a-f]{64}, not 0{64}\n$/);
  assert.ok(!existsSync(join(dir, "another home", ".player-two")));

  // With no digest beside the archive there is no script to serve.
  rmSync(join(folder, "wsl-runtime.tar.gz.sha256"));
  const none = await ask(hub, "/install.sh");
  assert.deepEqual([none.status, none.body], [404, JSON.stringify({ detail: "wsl-runtime.tar.gz.sha256 is not on this hub, so there is no runtime to install" })]);
});
