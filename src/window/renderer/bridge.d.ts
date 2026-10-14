import type { Bridge } from "../../shared/ipc.ts";

declare global {
  interface Window {
    readonly playerTwo: Bridge;
  }
  /** The hub's address this copy was built for, from PLAYER_TWO_HUB_URL when build.mjs ran; "" when the person joining types it. */
  const PLAYER_TWO_HUB_URL: string;
}
