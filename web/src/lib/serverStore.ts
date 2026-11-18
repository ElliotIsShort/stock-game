import { isServerCode } from "@fsm/shared";

/**
 * Per-device memory of which server a person last used (only ever consulted
 * when they belong to several). Namespaced by uid so two people sharing a
 * browser don't inherit each other's choice.
 */
const lastKey = (uid: string) => `fsm:lastServer:${uid}`;

export function rememberServer(uid: string, serverId: string): void {
  try {
    if (isServerCode(serverId)) localStorage.setItem(lastKey(uid), serverId);
  } catch {
    // Private mode / storage full: the choice just isn't remembered.
  }
}

export function recallServer(uid: string): string | null {
  try {
    const v = localStorage.getItem(lastKey(uid));
    return isServerCode(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Per-server client storage keys. Everything that is about one game (recap,
 * previous session, results seen, view-as-player) is namespaced by server id so
 * one server's state can never leak into another's. Theme/sound preferences and
 * the dev diary's "unread" marker stay global on purpose.
 */
export const storageKey = {
  recap: (serverId: string, uid: string) => `fsm:recap:${serverId}:${uid}`,
  previous: (serverId: string, uid: string) => `fsm:previous:${serverId}:${uid}`,
  resultsSeen: (serverId: string, uid: string) => `fsm:resultsSeen:${serverId}:${uid}`,
  viewAsPlayer: (serverId: string) => `fsm:viewAsPlayer:${serverId}`,
};
