/**
 * Builds the Linux runtime the window installs into WSL: Node 26 for x64, the libatomic it needs, the command, and the two scripts that start it, packed as dist/wsl-runtime.tar.gz with its SHA-256 beside it.
 * Run it after `npm run build`, on Linux, where the scripts keep the mode that lets them run: `node scripts/build-runtime.ts`. Node's tarball is kept in .cache/node, so a second run downloads nothing.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const NODE_DIST = "https://nodejs.org/dist/latest-v26.x";
const ROOT = join(import.meta.dirname, "..");
const CACHE = join(ROOT, ".cache", "node");

// The command. It is reached through ~/.local/bin/player-two and ~/.player-two/current, both links, so it finds its own folder from where they lead.
// --use-env-proxy makes requests honour HTTPS_PROXY and NO_PROXY, and --use-system-ca has them trust what Ubuntu trusts, a company's own CA included.
// lib/native holds libatomic.so.1, which Node links against and Ubuntu's WSL images do not have; what the desk starts inherits the path, which only adds that one library.
export const WRAPPER = `#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
export LD_LIBRARY_PATH="$here/../lib/native\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$here/node" --use-env-proxy --use-system-ca "$here/../lib/player-two.js" "$@"
`;

// What the window starts through wsl.exe. A login shell runs it, so the desk has the user's own environment and nothing has to be quoted on the Windows side.
export const LAUNCHER = `#!/bin/bash -l
exec "$(dirname "$0")/player-two" desk
`;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command: string, args: readonly string[]): void {
  const done = spawnSync(command, args, { encoding: "utf8" });
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${done.error?.message ?? done.stderr}`);
  }
}

/** The linux-x64 tarball named in a SHASUMS256.txt, and its SHA-256. Null when there is none. */
export function tarballIn(sums: string): { readonly name: string; readonly digest: string } | null {
  const [, digest, name] = /^([0-9a-f]{64}) {2}(node-v26\.\d+\.\d+-linux-x64\.tar\.gz)$/m.exec(sums) ?? [];
  return digest === undefined || name === undefined ? null : { name, digest };
}

/** Where `ldd` says Node finds libatomic.so.1 on this machine. Null when it does not find it. */
export function libatomicIn(ldd: string): string | null {
  return /^\s*libatomic\.so\.1 => (\/\S+)/m.exec(ldd)?.[1] ?? null;
}

/** Pack `node`, the `libatomic` it links against and the built `command` as the runtime, with `bin/` and `lib/` at the top of the archive as the install script expects, and write its digest beside it. Returns the digest. */
export function pack(node: string, libatomic: string, command: string, archive: string): string {
  const stage = mkdtempSync(join(dirname(archive), "runtime-"));
  try {
    mkdirSync(join(stage, "bin"));
    mkdirSync(join(stage, "lib", "native"), { recursive: true });
    copyFileSync(node, join(stage, "bin", "node"));
    copyFileSync(libatomic, join(stage, "lib", "native", "libatomic.so.1")); // The file a link names, not the link.
    copyFileSync(command, join(stage, "lib", "player-two.js"));
    writeFileSync(join(stage, "bin", "player-two"), WRAPPER, { mode: 0o755 });
    writeFileSync(join(stage, "bin", "player-two-desk"), LAUNCHER, { mode: 0o755 });
    run("tar", ["-czf", archive, "-C", stage, "bin", "lib"]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const digest = sha256(archive);
  writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`); // sha256sum's own format: `sha256sum -c` reads it.
  return digest;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${String(response.status)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

if (import.meta.main) {
  const tarball = tarballIn((await download(`${NODE_DIST}/SHASUMS256.txt`)).toString("utf8"));
  if (tarball === null) {
    throw new Error(`${NODE_DIST}/SHASUMS256.txt names no linux-x64 tarball`);
  }
  const cached = join(CACHE, tarball.name);
  if (!existsSync(cached) || sha256(cached) !== tarball.digest) {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, await download(`${NODE_DIST}/${tarball.name}`));
  }
  if (sha256(cached) !== tarball.digest) {
    throw new Error(`${tarball.name} does not match its SHA-256 in SHASUMS256.txt`);
  }
  const unpacked = tarball.name.replace(/\.tar\.gz$/, "");
  run("tar", ["-xzf", cached, "-C", CACHE, `${unpacked}/bin/node`]);
  const node = join(CACHE, unpacked, "bin", "node");
  const ldd = spawnSync("ldd", [node], { encoding: "utf8" });
  const libatomic = libatomicIn(ldd.stdout);
  if (libatomic === null) {
    throw new Error(
      `ldd finds no libatomic.so.1 for ${node}, which the runtime ships for Ubuntu's WSL images that lack it; on Debian or Ubuntu: apt install libatomic1. ldd said:\n${ldd.stdout}${ldd.stderr}`
    );
  }
  const digest = pack(node, libatomic, join(ROOT, "dist", "player-two.js"), join(ROOT, "dist", "wsl-runtime.tar.gz"));
  console.log(`dist/wsl-runtime.tar.gz: ${unpacked}, sha256 ${digest}`);
}
