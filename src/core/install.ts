/** Installing the Linux runtime: the script that does it, as text. The window feeds it to the user's distribution and the hub serves it to someone on Linux, so it lives where both can reach it. */

/** Text as one word of a shell script, whatever is in it. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The script that installs the runtime in `archivePath`, a .tar.gz with `bin/` and `lib/` at its top, whose SHA-256 is `digest` in lowercase hex.
 * It is plain POSIX `sh`, and running it again changes nothing. Each runtime is kept under its own digest, `~/.player-two/current` points at the one in use,
 * and `~/.player-two/previous` at the one before it, which is kept in case something started from it is still running. Any other is removed.
 */
export function installScript(archivePath: string, digest: string): string {
  // ponytail: two installs at once can each unpack and the second `mv` then lands inside the first's folder. Take a lock with `mkdir` if the window is ever allowed to run twice.
  return `set -eu
archive=${quote(archivePath)}
digest=${quote(digest)}
root="$HOME/.player-two"
runtime="$root/runtime/sha256-$digest"

actual=$(sha256sum "$archive" | cut -d ' ' -f 1)
if [ "$actual" != "$digest" ]; then
  echo "the runtime archive $archive is damaged: its SHA-256 is \${actual:-unknown}, not $digest" >&2
  exit 1
fi

mkdir -p "$root/runtime" "$HOME/.local/bin"
if [ ! -d "$runtime" ]; then
  rm -rf "$runtime.new"
  mkdir "$runtime.new"
  tar -xzf "$archive" -C "$runtime.new"
  mv "$runtime.new" "$runtime"
fi

was=$(readlink "$root/current" 2>/dev/null || true)
if [ "$was" != "$runtime" ]; then
  if [ -n "$was" ]; then
    ln -sfn "$was" "$root/previous"
  fi
  ln -sfn "$runtime" "$root/current"
fi
ln -sfn "$root/current/bin/player-two" "$HOME/.local/bin/player-two"

keep=$(readlink "$root/previous" 2>/dev/null || true)
for each in "$root"/runtime/*; do
  if [ "$each" != "$runtime" ] && [ "$each" != "$keep" ]; then
    rm -rf "$each"
  fi
done
`;
}
