/**
 * Multiple independent games ("servers") on one site. Pure helpers shared by
 * the functions, the web app and the migration script.
 *
 * A server is addressed by a random 6-digit numeric code that is also its
 * document id (`servers/482915`). The code is immutable; only the display name
 * can change. Players must never learn that servers exist, so everything that
 * decides what to show lives in `resolveServer`/`serverUiVisible`.
 */

export type ServerStatus = "active" | "archived";

/** `servers/{code}`. */
export interface ServerDoc {
  /** Same as the document id. */
  slug: string;
  /** What the owner sees. Editable. */
  name: string;
  status: ServerStatus;
  createdAt: number;
  /** Denormalised copy of `meta/state.closesAt`, so the scheduler finds due servers with one query. */
  closesAt: number;
  /** Optional per-server kill switch (the global `system/maintenance` also applies). */
  maintenance?: boolean;
  /** Whether a Discord webhook is set (the URL itself is server-only). Maintained by `setDiscordWebhook`. */
  hasDiscordWebhook?: boolean;
}

/** `users/{uid}`: a lookup cache maintained by functions. Membership is defined by `servers/{id}/players/{uid}`. */
export interface UserDoc {
  serverIds: string[];
}

/** First digit 1-9, then five digits. */
export const SERVER_CODE_RE = /^[1-9][0-9]{5}$/;

export function isServerCode(v: unknown): v is string {
  return typeof v === "string" && SERVER_CODE_RE.test(v);
}

/** A random server code, e.g. "482915". `rand` returns [0,1) (injectable for tests). */
export function randomServerCode(rand: () => number = Math.random): string {
  const first = 1 + Math.floor(rand() * 9);
  let rest = "";
  for (let i = 0; i < 5; i++) rest += String(Math.min(9, Math.floor(rand() * 10)));
  return `${Math.min(9, first)}${rest}`;
}

/**
 * Generate a code and claim it with `tryClaim` (a create-only write that
 * returns false when the id already exists), retrying on collision.
 */
export async function claimServerCode(
  tryClaim: (code: string) => Promise<boolean>,
  rand: () => number = Math.random,
  maxAttempts = 20,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const code = randomServerCode(rand);
    if (await tryClaim(code)) return code;
  }
  throw new Error("Couldn't find a free server code.");
}

/** Firestore paths for one server's data. Everything game-related goes through here. */
export function serverPaths(serverId: string) {
  const root = `servers/${serverId}`;
  return {
    root,
    config: `${root}/config/global`,
    content: `${root}/content/global`,
    state: `${root}/meta/state`,
    players: `${root}/players`,
    player: (uid: string) => `${root}/players/${uid}`,
    stocks: `${root}/stocks`,
    stock: (id: string) => `${root}/stocks/${id}`,
    holdings: `${root}/holdings`,
    holding: (uid: string, stockId: string) => `${root}/holdings/${uid}_${stockId}`,
    shorts: `${root}/shorts`,
    trades: `${root}/trades`,
    posts: `${root}/posts`,
    photos: `${root}/photos`,
    photo: (uid: string) => `${root}/photos/${uid}`,
    alerts: `${root}/alerts`,
    notifications: `${root}/notifications`,
    discordOutbox: `${root}/discordOutbox`,
    discordRate: `${root}/discordState/rate`,
    netWorthHistory: `${root}/netWorthHistory`,
    netWorthSeries: `${root}/netWorthSeries`,
    weeklyReports: `${root}/weeklyReports`,
    privateDiscord: `${root}/private/discord`,
  };
}

/** Collections (and fixed docs) copied by the legacy migration, relative to the server root. */
export const SERVER_COLLECTIONS = [
  "config",
  "content",
  "meta",
  "players",
  "stocks",
  "holdings",
  "shorts",
  "trades",
  "posts",
  "photos",
  "alerts",
  "notifications",
  "discordOutbox",
  "discordState",
  "netWorthHistory",
  "netWorthSeries",
  "weeklyReports",
] as const;

export type Landing =
  /** Not a member of anything (and not an admin): the registration / pending screen. */
  | { kind: "none" }
  /** Go straight to (or stay in) this server. */
  | { kind: "server"; serverId: string }
  /** Two or more memberships and nothing says which: show the picker. */
  | { kind: "picker" };

export interface ResolveInput {
  /** `?s=` from the URL, unvalidated. */
  requested: string | null | undefined;
  /** Last-used server on this device, unvalidated. */
  lastUsed: string | null | undefined;
  /** `users/{uid}.serverIds`. */
  memberships: readonly string[];
  isAdmin: boolean;
}

/**
 * Decide which server a signed-in user lands in. A `?s=` for a server the
 * user isn't in is ignored (admins may open any server). Invalid codes are
 * treated as absent.
 */
export function resolveServer({ requested, lastUsed, memberships, isAdmin }: ResolveInput): Landing {
  const mine = memberships.filter(isServerCode);
  const isMine = (s: unknown): s is string => isServerCode(s) && mine.includes(s);
  if (isServerCode(requested) && (isMine(requested) || isAdmin)) return { kind: "server", serverId: requested };
  if (mine.length === 1) return { kind: "server", serverId: mine[0] };
  if (isMine(lastUsed)) return { kind: "server", serverId: lastUsed };
  if (mine.length > 1) return { kind: "picker" };
  return { kind: "none" };
}

/** Anything server-related (name, switcher, picker, `?s=`) is shown only to people in two or more servers. */
export function serverUiVisible(memberships: readonly string[]): boolean {
  return memberships.filter(isServerCode).length > 1;
}

/**
 * Add `?s=<serverId>` to an internal href (keeping any query and #hash), or
 * return it unchanged when `serverId` is null (single-membership users never
 * see `?s=`).
 */
export function withServer(href: string, serverId: string | null | undefined): string {
  if (!serverId || !isServerCode(serverId)) return href;
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const noHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const qAt = noHash.indexOf("?");
  const path = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const params = new URLSearchParams(qAt >= 0 ? noHash.slice(qAt + 1) : "");
  params.set("s", serverId);
  return `${path}?${params.toString()}${hash}`;
}
