import { beforeEach, describe, expect, it } from "vitest";
import { call, clientRead, expectCallError, getDoc, listDocs, setupPlayers, wipeEmulators, type User } from "./helpers";

let alice: User; // admin + player
let bob: User;
let cara: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob, cara] = await setupPlayers("Alice", "Bob", "Cara");
});

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out");
}

describe("price alerts", () => {
  it("fires once when the price crosses, with an in-app notification", async () => {
    const alert = await call(bob, "createAlert", { stockId: cara.uid, direction: "above", price: 51 });
    expect(alert).toMatchObject({ uid: bob.uid, status: "active", direction: "above", price: 51 });

    await call(alice, "trade", { stockId: cara.uid, side: "buy", amount: 200 });
    const fired = await waitFor(async () => {
      const a = await getDoc(`alerts/${alert.id}`);
      return a?.status === "triggered" ? a : undefined;
    });
    expect(fired.triggeredPrice).toBeGreaterThan(51);
    const notes = await waitFor(async () => {
      const n = (await listDocs("notifications")).filter((x) => x.uid === bob.uid);
      return n.length ? n : undefined;
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "alert", read: false, stockId: cara.uid });
    expect(notes[0].title).toContain("Cara is above £51.00");

    // Another trade doesn't fire it again.
    await call(alice, "trade", { stockId: cara.uid, side: "buy", amount: 50 });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await listDocs("notifications")).filter((x) => x.uid === bob.uid)).toHaveLength(1);

    expect(await call(bob, "markNotificationsRead", {})).toEqual({ updated: 1 });
    expect((await getDoc(`notifications/${notes[0].id}`)).read).toBe(true);
  });

  it("rejects alerts that would fire immediately, and caps how many you can have", async () => {
    await expectCallError(call(bob, "createAlert", { stockId: cara.uid, direction: "above", price: 40 }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "createAlert", { stockId: cara.uid, direction: "below", price: 60 }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "createAlert", { stockId: cara.uid, direction: "up", price: 60 }), "INVALID_ARGUMENT");

    await call(alice, "updateConfig", { patch: { maxActiveAlerts: 2 } });
    await call(bob, "createAlert", { stockId: cara.uid, direction: "above", price: 60 });
    const second = await call(bob, "createAlert", { stockId: cara.uid, direction: "below", price: 40 });
    await expectCallError(call(bob, "createAlert", { stockId: alice.uid, direction: "above", price: 70 }), "RESOURCE_EXHAUSTED");
    // Cancelling frees a slot.
    await call(bob, "cancelAlert", { alertId: second.id });
    expect((await getDoc(`alerts/${second.id}`)).status).toBe("cancelled");
    await call(bob, "createAlert", { stockId: alice.uid, direction: "above", price: 70 });
  });

  it("keeps alerts and notifications private to their owner", async () => {
    const alert = await call(bob, "createAlert", { stockId: cara.uid, direction: "above", price: 60 });
    expect(await clientRead(bob, `alerts/${alert.id}`)).toBe(200);
    expect(await clientRead(cara, `alerts/${alert.id}`)).toBe(403);
    await expectCallError(call(cara, "cancelAlert", { alertId: alert.id }), "NOT_FOUND");
  });

  it("posts to Discord when asked", async () => {
    await call(bob, "createAlert", { stockId: cara.uid, direction: "below", price: 49, discord: true });
    // A short sells into the pool, pushing Cara's price down past £49.
    await call(alice, "openShort", { stockId: cara.uid, shares: 3 });
    const item = await waitFor(async () => (await listDocs("discordOutbox")).find((d) => d.kind === "priceAlert"));
    expect(item.priority).toBe("high");
    expect(item.message.ping).toContain(`{@${bob.uid}}, $CAR is now below £49.00`);
  });
});
