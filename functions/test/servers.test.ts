import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SERVER_CODE_RE, startingCash } from "@fsm/shared";
import {
  CallError,
  call,
  clientRead,
  expectCallError,
  getDoc,
  listDocs,
  makeAdmin,
  makeServer,
  patchDoc,
  registerUser,
  setClosesAt,
  setupPlayers,
  signUp,
  tickScheduler,
  waitFor,
  wipeEmulators,
  SERVER,
  type User,
} from "./helpers";

let alice: User; // admin + player in A
let bob: User;
let cara: User;
let dave: User;
let A: string;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob, cara, dave] = await setupPlayers("Alice", "Bob", "Cara", "Dave");
  A = SERVER;
});

/** A second server with Alice and Cara in it (Bob and Dave are not). */
async function serverB(): Promise<string> {
  const b = await makeServer(alice, "Server B", { switchTo: false });
  await call(alice, "addPlayerToServer", { uid: alice.uid, serverId: b, displayName: "Alice Two" });
  await call(alice, "addPlayerToServer", { uid: cara.uid, serverId: b, displayName: "Cara Two" });
  return b;
}

describe("createServer", () => {
  it("is admin-only and validates its input", async () => {
    const closesAt = Date.now() + 86_400_000;
    await expectCallError(call(bob, "createServer", { name: "Nope", closesAt }), "PERMISSION_DENIED");
    await expectCallError(call(null, "createServer", { name: "Nope", closesAt }), "UNAUTHENTICATED");
    await expectCallError(call(alice, "createServer", { name: "x", closesAt }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "createServer", { name: "Fine name", closesAt: Date.now() - 1000 }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "createServer", { name: "Fine name" }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "createServer", { name: "Fine name", closesAt, copyConfigFrom: "../x" }), "INVALID_ARGUMENT");
    await expectCallError(call(alice, "createServer", { name: "Fine name", closesAt, copyConfigFrom: "999999" }), "NOT_FOUND");
    expect(await listDocs("servers")).toHaveLength(1); // only the one from setup
  });

  it("generates a 6-digit code (never chosen by the caller) and initialises the server", async () => {
    const closesAt = Date.now() + 2 * 86_400_000;
    const res = await call(alice, "createServer", { name: "  Weekend   Crew ", closesAt, serverId: "111111", slug: "mine" });
    expect(res.serverId).toMatch(SERVER_CODE_RE);
    expect(res.serverId).not.toBe("111111");
    expect(res.name).toBe("Weekend Crew");
    const server = await getDoc(`servers/${res.serverId}`);
    expect(server).toMatchObject({ slug: res.serverId, name: "Weekend Crew", status: "active", closesAt, hasDiscordWebhook: false });
    expect(await getDoc("meta/state", res.serverId)).toMatchObject({ currentWeek: 1, prizePool: 0, weekFees: 0, closesAt, lastCloseAt: null });
    expect(await getDoc("content/global", res.serverId)).toMatchObject({ rules: "" });
    expect(await getDoc("private/discord", res.serverId)).toBeNull();
    expect(await listDocs("players", res.serverId)).toEqual([]);
    expect((await listDocs("auditLog")).find((e) => e.action === "createServer" && e.targetId === res.serverId)).toMatchObject({ serverId: res.serverId });
    const second = await call(alice, "createServer", { name: "Another", closesAt });
    expect(second.serverId).not.toBe(res.serverId);
  });

  it("copies another server's settings, or starts from the defaults", async () => {
    await call(alice, "updateConfig", { patch: { weeklyAllowance: 345, tradingFeePct: 0.02 } });
    const closesAt = Date.now() + 86_400_000;
    const copied = await call(alice, "createServer", { name: "Copy", closesAt, copyConfigFrom: A });
    expect(await getDoc("config/global", copied.serverId)).toMatchObject({ weeklyAllowance: 345, tradingFeePct: 0.02 });
    const fresh = await call(alice, "createServer", { name: "Fresh", closesAt });
    expect(await getDoc("config/global", fresh.serverId)).toMatchObject({ weeklyAllowance: DEFAULT_CONFIG.weeklyAllowance, tradingFeePct: DEFAULT_CONFIG.tradingFeePct });
    // Later changes to the source don't leak into the copy.
    await call(alice, "updateConfig", { patch: { weeklyAllowance: 111 } });
    expect((await getDoc("config/global", copied.serverId)).weeklyAllowance).toBe(345);
  });
});

describe("isolation", () => {
  it("a member can't read another server's data; admins can read any", async () => {
    const b = await serverB();
    expect(await clientRead(bob, `players/${alice.uid}`, A)).toBe(200);
    expect(await clientRead(bob, `servers/${A}`)).toBe(200);
    expect(await clientRead(bob, `users/${bob.uid}`)).toBe(200);
    expect(await clientRead(bob, `users/${alice.uid}`)).toBe(403);
    for (const path of ["players/" + alice.uid, "stocks/" + alice.uid, "meta/state", "config/global", "content/global", "photos/x", "netWorthHistory/x", "weeklyReports/x"]) {
      expect(await clientRead(bob, path, b), path).toBe(403);
    }
    expect(await clientRead(bob, `servers/${b}`)).toBe(403);
    // Cara is in both; Bob is only in A, so a dave/bob can't see B even by id.
    expect(await clientRead(cara, `stocks/${alice.uid}`, b)).toBe(200);
    expect(await clientRead(alice, `stocks/${alice.uid}`, b)).toBe(200);
    // Alice is in B too, but a never-joined admin could read it as well.
    const root = await signUp("root");
    await makeAdmin(root);
    expect(await clientRead(root, `stocks/${alice.uid}`, b)).toBe(200);
    expect(await clientRead(root, `stocks/${alice.uid}`, A)).toBe(200);
  });

  it("calling a function with another server's id as a non-member fails, and unknown or malformed ids are refused", async () => {
    const b = await serverB();
    const attempts: [string, Record<string, unknown>][] = [
      ["trade", { stockId: alice.uid, side: "buy", amount: 10 }],
      ["createPost", { text: "hi" }],
      ["touch", {}],
      ["setDiscordId", { discordId: null }],
      ["createAlert", { stockId: alice.uid, direction: "above", price: 99, discord: false }],
      ["markNotificationsRead", {}],
      ["setTicker", { ticker: "ZZZ" }],
      ["openShort", { stockId: alice.uid, shares: 1 }],
    ];
    for (const [fn, data] of attempts) {
      const err = await expectCallError(call(bob, fn, { ...data, serverId: b }), "PERMISSION_DENIED");
      expect(err.message).not.toMatch(/server|group/i);
    }
    // A code that doesn't exist looks exactly the same as one that does.
    const ghost = await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 10, serverId: "999999" }), "PERMISSION_DENIED");
    expect(ghost.message).toBe((await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 10, serverId: b }), "PERMISSION_DENIED")).message);
    for (const bad of ["abc", "012345", "1234567", "../servers/x", 123456, null]) {
      await expectCallError(call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 10, serverId: bad }), "INVALID_ARGUMENT");
    }
    // Admin operations need an admin even with a valid id.
    for (const fn of ["updateConfig", "delistPlayer", "runWeeklyClose", "setCloseTime", "renamePlayer", "updateContent", "resetGame", "testDiscord", "sendDiscordDigest", "setDiscordWebhook", "archiveServer"]) {
      await expectCallError(call(bob, fn, { serverId: A }), "PERMISSION_DENIED");
    }
    expect((await getDoc(`players/${bob.uid}`, A)).cash).toBe(1000);
  });

  it("the same user has independent player, cash, stock, holdings, ticker and name in two servers", async () => {
    const b = await serverB();
    expect(await getDoc(`players/${alice.uid}`, A)).toMatchObject({ displayName: "Alice", cash: 1000 });
    expect(await getDoc(`players/${alice.uid}`, b)).toMatchObject({ displayName: "Alice Two", cash: 1000 });
    expect((await getDoc(`users/${alice.uid}`)).serverIds.sort()).toEqual([A, b].sort());

    await call(alice, "trade", { stockId: bob.uid, side: "buy", amount: 300, serverId: A });
    expect((await getDoc(`players/${alice.uid}`, A)).cash).toBeCloseTo(700, 9);
    expect((await getDoc(`players/${alice.uid}`, b)).cash).toBe(1000);
    expect(await getDoc(`holdings/${alice.uid}_${bob.uid}`, A)).not.toBeNull();
    expect(await listDocs("holdings", b)).toEqual([]);

    await call(alice, "setTicker", { ticker: "ONE", serverId: A });
    await call(alice, "setTicker", { ticker: "TWO", serverId: b });
    expect((await getDoc(`stocks/${alice.uid}`, A)).ticker).toBe("ONE");
    expect((await getDoc(`stocks/${alice.uid}`, b)).ticker).toBe("TWO");
    await call(alice, "renamePlayer", { uid: alice.uid, displayName: "Alicia", serverId: A });
    expect((await getDoc(`players/${alice.uid}`, A)).displayName).toBe("Alicia");
    expect((await getDoc(`players/${alice.uid}`, b)).displayName).toBe("Alice Two");
    expect((await getDoc(`stocks/${alice.uid}`, b)).displayName).toBe("Alice Two");
    // The account-wide registration is untouched by a per-server rename.
    expect((await getDoc(`registrations/${alice.uid}`)).displayName).toBe("Alice");
  });

  it("names and tickers may repeat across servers but are unique within one", async () => {
    const b = await makeServer(alice, "Server B", { switchTo: false });
    const sam1 = await registerUser("Sam");
    const sam2 = await registerUser("sam");
    const sam3 = await registerUser("SAM");
    await call(alice, "approvePlayer", { uid: sam1.uid, serverId: A });
    await call(alice, "approvePlayer", { uid: sam2.uid, serverId: b });
    // Same name inside A is refused (case-insensitive), and the registration stays pending.
    await expectCallError(call(alice, "approvePlayer", { uid: sam3.uid, serverId: A }), "ALREADY_EXISTS");
    expect((await getDoc(`registrations/${sam3.uid}`)).status).toBe("pending");
    expect(await getDoc(`players/${sam3.uid}`, A)).toBeNull();
    // Both Sams got the same default ticker, one per server.
    expect((await getDoc(`stocks/${sam1.uid}`, A)).ticker).toBe("SAM");
    expect((await getDoc(`stocks/${sam2.uid}`, b)).ticker).toBe("SAM");
    // Within A the ticker is taken; in B it's free.
    await expectCallError(call(bob, "setTicker", { ticker: "SAM", serverId: A }), "ALREADY_EXISTS");
    await call(alice, "addPlayerToServer", { uid: bob.uid, serverId: b });
    await call(bob, "setTicker", { ticker: "SAM", serverId: b }).then(
      () => expect.unreachable("SAM is taken in B too"),
      (e: CallError) => expect(e.status).toBe("ALREADY_EXISTS"),
    );
    await call(bob, "setTicker", { ticker: "BBB", serverId: b });
    // A rename in A can't collide with a name in A, but can match one in B.
    await expectCallError(call(alice, "renamePlayer", { uid: bob.uid, displayName: "sam", serverId: A }), "ALREADY_EXISTS");
    await call(alice, "renamePlayer", { uid: bob.uid, displayName: "Alice Two", serverId: A });
  });

  it("a trade in A leaves B's prices, pools and state unchanged", async () => {
    const b = await serverB();
    const snapshot = async () => ({
      stocks: await listDocs("stocks", b),
      players: await listDocs("players", b),
      state: await getDoc("meta/state", b),
      trades: await listDocs("trades", b),
      posts: await listDocs("posts", b),
    });
    const before = await snapshot();
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 250, postText: "only in A", serverId: A });
    await call(cara, "openShort", { stockId: dave.uid, shares: 2, serverId: A });
    await call(bob, "createPost", { text: "hello A", serverId: A });
    await new Promise((r) => setTimeout(r, 1500)); // let the triggers run
    expect(await snapshot()).toEqual(before);
    expect(await listDocs("netWorthSeries", b)).toEqual([]);
    expect((await getDoc(`stocks/${alice.uid}`, A)).price).toBeGreaterThan(before.stocks.find((s) => s.id === alice.uid).price);
    expect((await getDoc("meta/state", A)).prizePool).toBeGreaterThan(0);
    expect((await getDoc("meta/state", b)).prizePool).toBe(0);
  });

  it("close, delist and reset affect only the named server", async () => {
    const b = await serverB();
    await call(cara, "trade", { stockId: alice.uid, side: "buy", amount: 100, serverId: b });
    await call(alice, "runWeeklyClose", { expectedWeek: 1, serverId: b });
    expect((await getDoc("meta/state", b)).currentWeek).toBe(2);
    expect((await getDoc("meta/state", A)).currentWeek).toBe(1);
    await call(alice, "delistPlayer", { uid: cara.uid, serverId: b });
    expect((await getDoc(`stocks/${cara.uid}`, b)).listed).toBe(false);
    expect((await getDoc(`stocks/${cara.uid}`, A)).listed).toBe(true);

    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 100, serverId: A });
    const res = await call(alice, "resetGame", { confirm: "RESET", serverId: b });
    expect(res.deleted.players).toBe(2);
    expect(await listDocs("players", b)).toEqual([]);
    expect(await getDoc("meta/state", b)).toMatchObject({ currentWeek: 1 });
    // A is untouched, and the shared account stays approved because they're still in A.
    expect(await listDocs("players", A)).toHaveLength(4);
    expect((await getDoc(`players/${bob.uid}`, A)).cash).toBeLessThan(1000);
    expect((await getDoc(`registrations/${alice.uid}`)).status).toBe("approved");
    expect((await getDoc(`users/${alice.uid}`)).serverIds).toEqual([A]);
    // The server itself and its settings survive a reset.
    expect(await getDoc(`servers/${b}`)).toMatchObject({ name: "Server B", status: "active" });
  });
});

describe("approval into a chosen server and adding existing users", () => {
  it("approvePlayer places the user in the chosen server only, with that server's catch-up cash and listing price", async () => {
    const b = await makeServer(alice, "Server B", { switchTo: false });
    await call(alice, "addPlayerToServer", { uid: alice.uid, serverId: b, displayName: "Alice Two" });
    await call(alice, "addPlayerToServer", { uid: bob.uid, serverId: b, displayName: "Bob Two" });
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 300, serverId: b });
    await call(alice, "runWeeklyClose", { expectedWeek: 1, serverId: b });
    const priceB = (await getDoc(`stocks/${alice.uid}`, b)).price;

    const eve = await registerUser("Eve");
    const res = await call(alice, "approvePlayer", { uid: eve.uid, serverId: b });
    // Week 2 in B: catch-up allowance; A is still week 1.
    expect(res.startingCash).toBe(startingCash(2, DEFAULT_CONFIG));
    const medianB = ((await listDocs("stocks", b)).filter((s) => s.id !== eve.uid).map((s) => s.price).sort((x, y) => x - y));
    expect(res.listingPrice).toBeCloseTo((medianB[0] + medianB[1]) / 2, 9);
    expect(priceB).not.toBe(DEFAULT_CONFIG.baseStockPrice);
    expect(await getDoc(`players/${eve.uid}`, A)).toBeNull();
    expect(await getDoc(`stocks/${eve.uid}`, A)).toBeNull();
    expect((await getDoc(`users/${eve.uid}`)).serverIds).toEqual([b]);
    expect(await getDoc(`registrations/${eve.uid}`)).toMatchObject({ status: "approved", decidedBy: alice.uid });
    // System listing post and Discord item are in B, not A.
    expect((await listDocs("posts", b)).some((p) => p.system && p.text.startsWith("Eve has listed"))).toBe(true);
    expect((await listDocs("posts", A)).some((p) => String(p.text).includes("Eve"))).toBe(false);
    expect((await getDoc(`players/${eve.uid}`, b)).joinWeek).toBe(2);
    expect((await listDocs("auditLog")).find((e) => e.action === "approvePlayer" && e.targetId === eve.uid)).toMatchObject({ serverId: b });
    // And the same user can be added to A later, as a founder of week 1.
    const again = await call(alice, "addPlayerToServer", { uid: eve.uid, serverId: A });
    expect(again.startingCash).toBe(DEFAULT_CONFIG.baseStartingCash);
    expect((await getDoc(`users/${eve.uid}`)).serverIds.sort()).toEqual([A, b].sort());
  });

  it("addPlayerToServer: admin-only, only for approved users, once per server, optional per-server name", async () => {
    const b = await makeServer(alice, "Server B", { switchTo: false });
    const pending = await registerUser("Pending");
    await expectCallError(call(bob, "addPlayerToServer", { uid: bob.uid, serverId: b }), "PERMISSION_DENIED");
    await expectCallError(call(alice, "addPlayerToServer", { uid: pending.uid, serverId: b }), "FAILED_PRECONDITION");
    await expectCallError(call(alice, "addPlayerToServer", { uid: "nobody", serverId: b }), "NOT_FOUND");
    await expectCallError(call(alice, "addPlayerToServer", { uid: bob.uid, serverId: A }), "ALREADY_EXISTS");
    await expectCallError(call(alice, "addPlayerToServer", { uid: bob.uid, serverId: b, displayName: "x" }), "INVALID_ARGUMENT");
    await call(alice, "addPlayerToServer", { uid: bob.uid, serverId: b });
    expect((await getDoc(`players/${bob.uid}`, b)).displayName).toBe("Bob"); // defaults to the registered name
    await expectCallError(call(alice, "addPlayerToServer", { uid: bob.uid, serverId: b }), "ALREADY_EXISTS");
    // A pending user can't be approved by someone who isn't admin.
    await expectCallError(call(bob, "approvePlayer", { uid: pending.uid, serverId: b }), "PERMISSION_DENIED");
  });
});

describe("archiving, renaming and the read-only server", () => {
  it("an archived server rejects every mutation (with player-safe wording) but stays readable", async () => {
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 50 });
    await call(alice, "archiveServer", {});
    expect((await getDoc(`servers/${A}`)).status).toBe("archived");
    const attempts: [User, string, Record<string, unknown>][] = [
      [bob, "trade", { stockId: alice.uid, side: "buy", amount: 10 }],
      [bob, "openShort", { stockId: alice.uid, shares: 1 }],
      [bob, "createPost", { text: "hi" }],
      [bob, "setTicker", { ticker: "ZZZ" }],
      [bob, "touch", {}],
      [alice, "updateConfig", { patch: { weeklyAllowance: 1 } }],
      [alice, "runWeeklyClose", { expectedWeek: 1 }],
      [alice, "setCloseTime", { closesAt: Date.now() + 86_400_000 }],
      [alice, "approvePlayer", { uid: (await registerUser("Late")).uid }],
    ];
    for (const [u, fn, data] of attempts) {
      const err = await expectCallError(call(u, fn, data), "FAILED_PRECONDITION");
      expect(err.message, fn).not.toMatch(/server|group/i);
    }
    expect(await clientRead(bob, `players/${alice.uid}`)).toBe(200);
    expect(await clientRead(bob, `servers/${A}`)).toBe(200);
    expect((await getDoc(`players/${bob.uid}`)).cash).toBeCloseTo(950, 9);
    // The admin can still rename and unarchive it.
    await call(alice, "renameServer", { name: "Archived name" });
    await call(alice, "unarchiveServer", {});
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 10 });
  });

  it("renameServer changes only the display name; the code never changes", async () => {
    await expectCallError(call(bob, "renameServer", { name: "Hijack" }), "PERMISSION_DENIED");
    await expectCallError(call(alice, "renameServer", { name: "x" }), "INVALID_ARGUMENT");
    const res = await call(alice, "renameServer", { name: "  New   Name " });
    expect(res).toMatchObject({ serverId: A, from: "Test", to: "New Name" });
    expect(await getDoc(`servers/${A}`)).toMatchObject({ slug: A, name: "New Name", status: "active" });
    expect((await listDocs("auditLog")).find((e) => e.action === "renameServer")).toMatchObject({ serverId: A, details: { from: "Test", to: "New Name" } });
  });
});

describe("margin deadline sweep across servers", () => {
  /** Bob buys Dave (£600), shorts Cara (9), then buys Alice (£500): margin called. All in `serverId`. */
  async function getBobCalled(serverId: string) {
    await call(bob, "trade", { stockId: dave.uid, side: "buy", amount: 600, serverId });
    await call(bob, "openShort", { stockId: cara.uid, shares: 9, serverId });
    await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 500, serverId });
    return waitFor(async () => {
      const p = await getDoc(`players/${bob.uid}`, serverId);
      return p?.marginCall ? p : undefined;
    }, 15_000, `Bob's margin call in ${serverId}`);
  }
  async function twoCalledServers() {
    const b = await makeServer(alice, "Server B", { switchTo: false });
    for (const u of [alice, bob, cara, dave]) await call(alice, "addPlayerToServer", { uid: u.uid, serverId: b });
    const [pa, pb] = [await getBobCalled(A), await getBobCalled(b)];
    for (const [id, p] of [[A, pa], [b, pb]] as const) {
      await patchDoc(`players/${bob.uid}`, { marginCall: { ...p.marginCall, deadline: Date.now() - 1000 } }, id);
    }
    return b;
  }
  const forced = async (id: string) => (await listDocs("trades", id)).filter((t) => t.kind === "liquidation");

  it("one tick force-liquidates overdue calls in every active server", async () => {
    const b = await twoCalledServers();
    await tickScheduler();
    expect((await forced(A)).length).toBeGreaterThan(0);
    expect((await forced(b)).length).toBeGreaterThan(0);
    for (const id of [A, b]) {
      expect((await getDoc(`players/${bob.uid}`, id)).marginCall).toBeUndefined();
      expect((await listDocs("auditLog")).some((e) => e.action === "forcedLiquidation" && e.serverId === id)).toBe(true);
    }
  });

  it("skips archived servers", async () => {
    const b = await twoCalledServers();
    await call(alice, "archiveServer", { serverId: b });
    await tickScheduler();
    expect((await forced(A)).length).toBeGreaterThan(0);
    expect(await forced(b)).toEqual([]);
    expect((await getDoc(`players/${bob.uid}`, b)).marginCall).toBeDefined();
    // Reopened, the next tick sorts it out.
    await call(alice, "unarchiveServer", { serverId: b });
    await tickScheduler();
    expect((await forced(b)).length).toBeGreaterThan(0);
  });
});

describe("security rules for global and private documents", () => {
  it("users/* is readable only by its owner, private/discord by nobody, and the legacy top-level collections by nobody", async () => {
    await call(alice, "setDiscordWebhook", { url: "http://127.0.0.1:8199/x" });
    for (const u of [alice, bob]) expect(await clientRead(u, "private/discord")).toBe(403);
    expect(await clientRead(alice, `users/${alice.uid}`)).toBe(200);
    expect(await clientRead(alice, `users/${bob.uid}`)).toBe(403);
    // Old-style top-level paths (the pre-migration layout, kept only as the rollback copy) are denied to everyone, admin included.
    for (const path of [`players/${bob.uid}`, `stocks/${bob.uid}`, "meta/state", "config/global", "trades/x", "posts/x"]) {
      await patchDoc(path, { x: 1 }, null);
      expect(await clientRead(alice, path, null), path).toBe(403);
      expect(await clientRead(bob, path, null), path).toBe(403);
    }
  });
});
