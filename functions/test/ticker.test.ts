import { beforeEach, describe, expect, it } from "vitest";
import { call, clientWrite, expectCallError, getDoc, listDocs, patchDoc, setupPlayers, signUp, wipeEmulators, type User } from "./helpers";

let alice: User; // admin + player
let bob: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob] = await setupPlayers("Alice Smith", "Bob Jones");
});

describe("tickers", () => {
  it("lists every stock with a unique default ticker from their name", async () => {
    expect((await getDoc(`stocks/${alice.uid}`)).ticker).toBe("ALI");
    expect((await getDoc(`stocks/${bob.uid}`)).ticker).toBe("BOB");
    const [carl] = await setupPlayersAs(alice, "Alicia Keys");
    expect((await getDoc(`stocks/${carl.uid}`)).ticker).toBe("KEY");
    const posts = await listDocs("posts");
    expect(posts.some((p) => p.system && p.text.includes("as $KEY"))).toBe(true);
  });

  it("lets a player pick their own ticker and announces it", async () => {
    expect(await call(bob, "setTicker", { ticker: "$bjx" })).toEqual({ ticker: "BJX", changed: true });
    const stock = await getDoc(`stocks/${bob.uid}`);
    expect(stock.ticker).toBe("BJX");
    expect(stock.tickerChangedAt).toBeGreaterThan(0);
    const posts = await listDocs("posts");
    expect(posts.some((p) => p.system && p.taggedStockId === bob.uid && p.text.includes("now trades as $BJX (was $BOB)"))).toBe(true);
  });

  it("rejects invalid and taken tickers", async () => {
    await expectCallError(call(bob, "setTicker", { ticker: "B" }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "setTicker", { ticker: "TOOLONG" }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "setTicker", { ticker: "B0B" }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "setTicker", { ticker: "ali" }), "ALREADY_EXISTS");
    expect((await getDoc(`stocks/${bob.uid}`)).ticker).toBe("BOB");
  });

  it("enforces the change cooldown for players but not admins", async () => {
    await call(bob, "setTicker", { ticker: "BJX" });
    await expectCallError(call(bob, "setTicker", { ticker: "BJY" }), "RESOURCE_EXHAUSTED");
    // Setting the same ticker again is a harmless no-op.
    expect(await call(bob, "setTicker", { ticker: "BJX" })).toEqual({ ticker: "BJX", changed: false });

    await call(alice, "setTicker", { uid: bob.uid, ticker: "BJZ" });
    expect((await getDoc(`stocks/${bob.uid}`)).ticker).toBe("BJZ");
    expect((await listDocs("auditLog")).some((e) => e.action === "setTicker" && e.targetId === bob.uid)).toBe(true);

    await call(alice, "updateConfig", { patch: { tickerChangeCooldownHours: 0 } });
    await call(bob, "setTicker", { ticker: "BJY" });
    expect((await getDoc(`stocks/${bob.uid}`)).ticker).toBe("BJY");
  });

  it("only admins can change someone else's ticker; non-players can't set one", async () => {
    await expectCallError(call(bob, "setTicker", { uid: alice.uid, ticker: "XYZ" }), "PERMISSION_DENIED");
    const stranger = await signUp("stranger");
    await expectCallError(call(stranger, "setTicker", { ticker: "XYZ" }), "NOT_FOUND");
  });

  it("backfills stocks listed before tickers existed, avoiding clashes", async () => {
    // Simulate legacy stocks by stripping their tickers.
    await patchDoc(`stocks/${alice.uid}`, { ticker: null });
    await patchDoc(`stocks/${bob.uid}`, { ticker: null });
    await call(bob, "setTicker", { ticker: "ALI" }).catch(() => undefined);
    // Alice's legacy default is ALI (listed first), so Bob can't take it.
    expect((await getDoc(`stocks/${bob.uid}`)).ticker).toBeNull();
    await call(bob, "setTicker", { ticker: "BJX" });
    expect((await getDoc(`stocks/${alice.uid}`)).ticker).toBe("ALI");
    expect((await getDoc(`stocks/${bob.uid}`)).ticker).toBe("BJX");
  });

  it("clients can't write tickers directly", async () => {
    expect(await clientWrite(bob, `stocks/${bob.uid}`, { ticker: "HAX" })).toBe(403);
  });
});

/** Register + approve extra players using an existing admin. */
async function setupPlayersAs(admin: User, ...names: string[]): Promise<User[]> {
  const users: User[] = [];
  for (const name of names) {
    const u = await signUp(name);
    await call(u, "register", { displayName: name });
    await call(admin, "approvePlayer", { uid: u.uid });
    users.push(u);
  }
  return users;
}
