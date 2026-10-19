import { beforeEach, describe, expect, it } from "vitest";
import { call, expectCallError, getDoc, listDocs, setupPlayers, wipeEmulators, type User } from "./helpers";

let alice: User;
let bob: User;
let cara: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob, cara] = await setupPlayers("Alice", "Bob", "Cara");
  // Most post tests fire several posts back-to-back; turn the spam cooldown
  // off so it doesn't interfere. The cooldown has its own block below.
  await call(alice, "updateConfig", { patch: { postCooldownSeconds: 0 } });
});

describe("posts (§7)", () => {
  it("can be standalone, about someone else, or about yourself", async () => {
    const standalone = await call(bob, "createPost", { text: "big week ahead" });
    expect(standalone).toMatchObject({ taggedStockId: null, linkedTradeId: null });
    const tagged = await call(bob, "createPost", { text: "Alice got promoted", taggedStockId: alice.uid });
    expect(tagged).toMatchObject({ taggedStockId: alice.uid, taggedName: "Alice" });
    const self = await call(bob, "createPost", { text: "I'm a great investment", taggedStockId: bob.uid });
    expect(self.taggedName).toBe("Bob");
  });

  it("never changes any price", async () => {
    const before = await getDoc(`stocks/${alice.uid}`);
    await call(bob, "createPost", { text: "Alice is the best", taggedStockId: alice.uid });
    expect((await getDoc(`stocks/${alice.uid}`)).price).toBe(before.price);
  });

  it("can be linked to your own trade afterwards, once", async () => {
    const t = await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 20 });
    const p = await call(bob, "createPost", { text: "why not", linkedTradeId: t.id });
    expect(p).toMatchObject({ linkedTradeId: t.id, taggedStockId: alice.uid });
    expect((await getDoc(`trades/${t.id}`)).linkedPostId).toBe(p.id);
    await expectCallError(call(bob, "createPost", { text: "again", linkedTradeId: t.id }), "ALREADY_EXISTS");
  });

  it("can't be linked to someone else's trade", async () => {
    const t = await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 20 });
    await expectCallError(call(cara, "createPost", { text: "hijack", linkedTradeId: t.id }), "PERMISSION_DENIED");
  });

  it("enforces the length limit and requires text", async () => {
    await expectCallError(call(bob, "createPost", { text: "x".repeat(501) }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "createPost", { text: "   " }), "INVALID_ARGUMENT");
  });
});

describe("post cooldown (spam guard)", () => {
  it("blocks a second post inside the cooldown window, per player", async () => {
    await call(alice, "updateConfig", { patch: { postCooldownSeconds: 3600 } });
    await call(bob, "createPost", { text: "first" });
    await expectCallError(call(bob, "createPost", { text: "second" }), "RESOURCE_EXHAUSTED");
    // The cooldown is per player: Cara is unaffected.
    await call(cara, "createPost", { text: "mine" });
    expect((await getDoc(`players/${bob.uid}`)).lastPostAt).toBeTypeOf("number");
  });

  it("allows back-to-back posts when the cooldown is 0", async () => {
    await call(bob, "createPost", { text: "one" });
    await call(bob, "createPost", { text: "two" });
    expect((await listDocs("posts")).filter((p) => p.authorId === bob.uid)).toHaveLength(2);
  });
});

describe("reactions", () => {
  it("toggle on and off, and are purely social", async () => {
    const post = await call(bob, "createPost", { text: "lol", taggedStockId: alice.uid });
    const priceBefore = (await getDoc(`stocks/${alice.uid}`)).price;
    await call(cara, "toggleReaction", { postId: post.id, reaction: "laugh" });
    await call(alice, "toggleReaction", { postId: post.id, reaction: "laugh" });
    expect((await getDoc(`posts/${post.id}`)).reactionCount).toBe(2);
    await call(cara, "toggleReaction", { postId: post.id, reaction: "laugh" });
    const after = await getDoc(`posts/${post.id}`);
    expect(after.reactionCount).toBe(1);
    expect(after.reactions.laugh).toEqual([alice.uid]);
    expect((await getDoc(`stocks/${alice.uid}`)).price).toBe(priceBefore);
    await expectCallError(call(cara, "toggleReaction", { postId: post.id, reaction: "love" }), "INVALID_ARGUMENT");
  });
});

describe("moderation", () => {
  it("only admins can delete posts, and it's audit-logged with the text", async () => {
    const t = await call(bob, "trade", { stockId: alice.uid, side: "buy", amount: 20, postText: "rude" });
    const trade = await getDoc(`trades/${t.id}`);
    await expectCallError(call(bob, "deletePost", { postId: trade.linkedPostId }), "PERMISSION_DENIED");

    await call(alice, "deletePost", { postId: trade.linkedPostId, reason: "be nice" });
    expect(await getDoc(`posts/${trade.linkedPostId}`)).toBeNull();
    expect((await getDoc(`trades/${t.id}`)).linkedPostId).toBeNull();
    const audit = (await listDocs("auditLog")).find((e) => e.action === "deletePost");
    expect(audit.details).toMatchObject({ text: "rude", reason: "be nice", authorId: bob.uid });
  });
});
