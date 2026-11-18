import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, resolveServer, serverPaths, serverUiVisible, type Landing, type Player, type ServerDoc, type Stock } from "@fsm/shared";

// Rendering needs no real Firebase or router: the data hooks see empty collections.
vi.mock("@/lib/firebase", () => ({ fb: () => ({ db: {}, auth: {}, functions: {} }), firebaseConfigured: true }));
vi.mock("firebase/firestore", () => ({
  collection: () => ({}),
  doc: () => ({}),
  query: () => ({}),
  where: () => ({}),
  orderBy: () => ({}),
  limit: () => ({}),
  onSnapshot: () => () => undefined,
  getDoc: async () => ({ exists: () => false }),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => undefined, signOut: async () => undefined, sendPasswordResetEmail: async () => undefined }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

import { GameContext, type GameContextValue, type PlayerView } from "@/components/GameProvider";
import { ServerContext, type ServerContextValue } from "@/components/ServerProvider";
import { Shell } from "@/components/Shell";
import { RegistrationGate } from "@/components/Registration";
import FeedPage from "@/app/page";
import MarketPage from "@/app/market/page";
import LeaderboardPage from "@/app/leaderboard/page";
import ReportsPage from "@/app/reports/page";
import RulesPage from "@/app/rules/page";

const A = "482915";
const B = "731064";
const SERVER_NAME = "DYF";
const OTHER_NAME = "Weekend Crew";

const now = Date.now();
const me: Player = {
  uid: "me",
  displayName: "Alice",
  cash: 1000,
  joinWeek: 1,
  isActive: true,
  isIdle: false,
  lastActiveAt: now,
  createdAt: now,
  startingCash: 1000,
  totalAllowances: 0,
  totalBonus: 0,
  netWorthWeekStart: 1000,
};
const meView: PlayerView = { ...me, netWorth: 1000, score: 1, holdingsValue: 0, rank: 1 };
const bobStock: Stock = {
  id: "bob", ownerId: "bob", displayName: "Bob", price: 50, poolCash: 1000, poolShares: 20, k: 20000, listed: true, listPrice: 50,
  listedAt: now, listedWeek: 1, weekOpenPrice: 50, weekHigh: 50, weekLow: 50, weekTradeCount: 0, ticker: "BOB",
};
const serverDoc = (slug: string, name: string): ServerDoc => ({ slug, name, status: "active", createdAt: now, closesAt: now + 86_400_000 });

/** What the providers would hand out for a signed-in player with these memberships. */
function world(memberships: string[], opts: { requested?: string; isAdmin?: boolean } = {}) {
  const landing: Landing = resolveServer({ requested: opts.requested ?? null, lastUsed: null, memberships, isAdmin: opts.isAdmin ?? false });
  const serverId = landing.kind === "server" ? landing.serverId : null;
  const showServerUi = serverUiVisible(memberships);
  const silent = memberships.length === 1 ? memberships[0] : null;
  const serverParam = serverId && (showServerUi || serverId !== silent) ? serverId : null;
  const user = { uid: "me", email: "alice@example.com", displayName: "Alice", providerData: [{ providerId: "password" }] } as never;
  const server: ServerContextValue = {
    configured: true, authLoading: false, user, signOut: async () => undefined, registration: null, isRealAdmin: opts.isAdmin ?? false,
    memberships, showServerUi, landing, serverId, serverParam, loading: false, switchServer: () => undefined,
  };
  const game: GameContextValue = {
    configured: true, authLoading: false, user, registration: null, me, isAdmin: opts.isAdmin ?? false, isRealAdmin: opts.isAdmin ?? false,
    previewingAsPlayer: false, setPreviewAsPlayer: () => undefined, isMember: serverId !== null, loadingMembership: false, signOut: async () => undefined,
    config: DEFAULT_CONFIG,
    state: { currentWeek: 3, prizePool: 12.5, weekFees: 0, weekStartedAt: now, lastCloseAt: null, closesAt: now + 86_400_000 },
    stocks: [bobStock], stockById: new Map([["bob", bobStock]]), players: [meView], playerById: new Map([["me", meView]]),
    holdings: [], myHoldings: [], myShorts: [], photoOf: () => undefined, tickerOf: (id) => (id === "bob" ? "BOB" : "ALI"), marketReady: true,
    recap: null, dismissRecap: () => undefined, previousSession: null, sessionKnown: true, notifications: [], myAlerts: [],
    serverId, server: serverId ? serverDoc(serverId, serverId === A ? SERVER_NAME : OTHER_NAME) : null, paths: serverId ? serverPaths(serverId) : null,
    showServerUi, memberships, landing, switchServer: () => undefined, maintenance: false,
  };
  return { server, game };
}

function render(node: ReactNode, w: ReturnType<typeof world>): string {
  return renderToStaticMarkup(
    <ServerContext.Provider value={w.server}>
      <GameContext.Provider value={w.game}>{node}</GameContext.Provider>
    </ServerContext.Provider>,
  );
}

const PAGES: [string, () => ReactNode][] = [
  ["feed", () => <FeedPage />],
  ["market", () => <MarketPage />],
  ["leaderboard", () => <LeaderboardPage />],
  ["reports", () => <ReportsPage />],
  ["rules", () => <RulesPage />],
];

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
/**
 * Everything a person can read or hear: text nodes plus label-ish attributes
 * (aria-label, title, placeholder, alt). `role="group"` is an ARIA role, not a word.
 */
function readable(html: string): string {
  const attrs = [...html.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]).join(" ");
  return `${html.replace(/<[^>]*>/g, " ")} ${attrs}`;
}
// Words players must never meet.
const FORBIDDEN = /\b(server|servers|group)\b/i;

describe("a player with one membership never sees that servers exist", () => {
  const w = world([A]);

  for (const [name, page] of PAGES) {
    it(`${name}: no server name, switcher or picker, no ?s= in any link, no "server"/"group"`, () => {
      const html = render(<Shell>{page()}</Shell>, w);
      expect(html.length).toBeGreaterThan(500); // the chrome rendered, not an error screen
      expect(html).not.toContain(SERVER_NAME);
      expect(html).not.toContain(A);
      expect(html).not.toMatch(/Switch server|Choose a server/i);
      expect(readable(html)).not.toMatch(FORBIDDEN);
      expect(hrefs(html)).toContain("/market"); // the nav is there, and plain
      for (const href of hrefs(html)) expect(href, href).not.toMatch(/[?&]s=/);
    });
  }

  it("a stray ?s= for a server they aren't in is ignored, and links stay plain", () => {
    const stray = world([A], { requested: B });
    expect(stray.game.serverId).toBe(A);
    expect(stray.server.serverParam).toBeNull();
    const html = render(<Shell>{<FeedPage />}</Shell>, stray);
    expect(html).not.toContain(OTHER_NAME);
    for (const href of hrefs(html)) expect(href, href).not.toMatch(/[?&]s=/);
  });

  it("the registration form and pending screen never mention servers or groups", () => {
    const none = world([]);
    const signedUp = { ...none, game: { ...none.game, registration: null, me: null, isMember: false } };
    const form = render(<RegistrationGate />, signedUp);
    expect(form).toContain("Request to join");
    expect(readable(form)).not.toMatch(FORBIDDEN);
    const pending = { ...signedUp, game: { ...signedUp.game, registration: { uid: "me", displayName: "Alice", email: null, status: "pending" as const, createdAt: now } } };
    const waiting = render(<RegistrationGate />, pending);
    expect(waiting).toContain("Waiting for approval");
    expect(readable(waiting)).not.toMatch(FORBIDDEN);
    // And the form has exactly the fields it always had: the display name.
    expect(form.match(/<input/g)).toHaveLength(1);
  });

  it("a signed-in user with no memberships gets the registration screen, never a picker", () => {
    const none = world([]);
    expect(none.game.landing).toEqual({ kind: "none" });
    const html = render(<Shell><FeedPage /></Shell>, { ...none, game: { ...none.game, me: null, registration: null } });
    expect(html).toContain("Join the market");
    expect(html).not.toMatch(/Choose a server/i);
  });
});

describe("a user with several memberships does see their servers", () => {
  const w = world([A, B], { requested: A });

  it("shows the current server's name, the switcher, and carries ?s= on links", () => {
    const html = render(<Shell><FeedPage /></Shell>, w);
    expect(html).toContain(SERVER_NAME);
    expect(html).toContain("Switch server");
    const links = hrefs(html).filter((h) => h.startsWith("/"));
    expect(links.length).toBeGreaterThan(5);
    for (const href of links) expect(href, href).toContain(`s=${A}`);
    expect(links).toContain(`/market?s=${A}`);
  });

  it("shows the picker when nothing says which server", () => {
    const picker = world([A, B]);
    expect(picker.game.landing).toEqual({ kind: "picker" });
    const html = render(<Shell><FeedPage /></Shell>, { ...picker, game: { ...picker.game, isMember: false, me: null } });
    expect(html).toContain("Choose a server");
  });
});
