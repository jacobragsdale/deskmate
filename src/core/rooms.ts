/** Branch rooms: channels pinned to one branch of a repo. No IO. */

/** Whether a checkout's branch, as the desk reads it, is one: a detached head reads "detached at a1b2c3d", and git allows no space in a branch's name. */
export function isBranch(branch: string): boolean {
  return !branch.includes(" ");
}
