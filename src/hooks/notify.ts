import type { PendingNotify } from "./shared-state.js";

export function createNotifyHandler(): (sessionID: string, notify: PendingNotify) => Promise<void> {
  return async () => {};
}
