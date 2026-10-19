import { beforeEach, describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES } from "@fsm/shared";
import { call, clientRead, clientWrite, expectCallError, getDoc, jpegDataUrl, listDocs, setupPlayers, signUp, wipeEmulators, type User } from "./helpers";

let alice: User; // admin + player
let bob: User;
beforeEach(async () => {
  await wipeEmulators();
  [alice, bob] = await setupPlayers("Alice", "Bob");
});

describe("stock photos", () => {
  it("players can set and remove their own photo", async () => {
    const photo = jpegDataUrl();
    expect(await call(bob, "setStockPhoto", { photo })).toMatchObject({ ok: true, hasPhoto: true });
    expect(await getDoc(`photos/${bob.uid}`)).toMatchObject({ uid: bob.uid, dataUrl: photo });

    await call(bob, "setStockPhoto", { photo: null });
    expect(await getDoc(`photos/${bob.uid}`)).toBeNull();
  });

  it("rejects non-images, mismatched contents and oversized photos", async () => {
    await expectCallError(call(bob, "setStockPhoto", { photo: "data:image/svg+xml;base64,PHN2Zz4=" }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "setStockPhoto", { photo: "data:image/png;base64,/9j/4AAQ" }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "setStockPhoto", { photo: "https://example.com/me.jpg" }), "INVALID_ARGUMENT");
    await expectCallError(call(bob, "setStockPhoto", { photo: jpegDataUrl(MAX_PHOTO_BYTES) }), "INVALID_ARGUMENT");
    expect(await getDoc(`photos/${bob.uid}`)).toBeNull();
  });

  it("only you can set your photo; admins can only remove other people's", async () => {
    await expectCallError(call(bob, "setStockPhoto", { uid: alice.uid, photo: jpegDataUrl() }), "PERMISSION_DENIED");
    await call(bob, "setStockPhoto", { photo: jpegDataUrl() });
    await expectCallError(call(alice, "setStockPhoto", { uid: bob.uid, photo: jpegDataUrl() }), "INVALID_ARGUMENT");

    await call(alice, "setStockPhoto", { uid: bob.uid, photo: null });
    expect(await getDoc(`photos/${bob.uid}`)).toBeNull();
    expect((await listDocs("auditLog")).some((e) => e.action === "removePhoto" && e.targetId === bob.uid)).toBe(true);
  });

  it("non-players can't set photos", async () => {
    const stranger = await signUp("stranger");
    await expectCallError(call(stranger, "setStockPhoto", { photo: jpegDataUrl() }), "NOT_FOUND");
  });

  it("photos are readable by members only and never writable by clients", async () => {
    await call(bob, "setStockPhoto", { photo: jpegDataUrl() });
    const pending = await signUp("p");
    await call(pending, "register", { displayName: "Pending" });
    expect(await clientRead(alice, `photos/${bob.uid}`)).toBe(200);
    expect(await clientRead(pending, `photos/${bob.uid}`)).toBe(403);
    expect(await clientWrite(bob, `photos/${bob.uid}`, { uid: bob.uid, dataUrl: "data:text/html,hi" })).toBe(403);
  });
});
