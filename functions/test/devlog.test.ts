import { beforeEach, describe, expect, it } from "vitest";
import { call, clientRead, clientWrite, expectCallError, getDoc, listDocs, setupPlayers, signUp, wipeEmulators, type User } from "./helpers";

let admin: User;
let bob: User;
beforeEach(async () => {
  await wipeEmulators();
  [admin, bob] = await setupPlayers("Admin", "Bob");
});

const DAY = Date.UTC(2026, 9, 28, 12);

describe("dev diary", () => {
  it("admins can create, edit and delete entries", async () => {
    const e = await call(admin, "saveDevlogEntry", { title: " Big update ", body: "## New\n- Things", date: DAY });
    expect(e).toMatchObject({ title: "Big update", body: "## New\n- Things", date: DAY });
    expect(await getDoc(`devlog/${e.id}`)).toMatchObject({ title: "Big update" });

    const edited = await call(admin, "saveDevlogEntry", { id: e.id, title: "Bigger update", body: "Changed", date: DAY - 86_400_000 });
    expect(edited).toMatchObject({ id: e.id, title: "Bigger update", createdAt: e.createdAt });
    expect(edited.updatedAt).toBeGreaterThanOrEqual(e.updatedAt);

    await call(admin, "deleteDevlogEntry", { id: e.id });
    expect(await getDoc(`devlog/${e.id}`)).toBeNull();
    const audit = (await listDocs("auditLog")).find((a) => a.action === "deleteDevlogEntry");
    expect(audit.details.body).toBe("Changed");
  });

  it("rejects bad entries and non-admins", async () => {
    await expectCallError(call(admin, "saveDevlogEntry", { title: "", body: "x", date: DAY }), "INVALID_ARGUMENT");
    await expectCallError(call(admin, "saveDevlogEntry", { title: "t", body: "x", date: "today" }), "INVALID_ARGUMENT");
    await expectCallError(call(admin, "saveDevlogEntry", { id: "nope", title: "t", body: "x", date: DAY }), "NOT_FOUND");
    await expectCallError(call(bob, "saveDevlogEntry", { title: "t", body: "x", date: DAY }), "PERMISSION_DENIED");
    await expectCallError(call(bob, "importDevlog"), "PERMISSION_DENIED");
  });

  it("imports the old change log once, with its dates", async () => {
    const first = await call(admin, "importDevlog");
    expect(first.added).toEqual(["Profiles, awards and Discord", "Short selling is here", "Welcome to Stonker"]);
    expect((await call(admin, "importDevlog")).added).toEqual([]);
    const entries = await listDocs("devlog");
    expect(entries).toHaveLength(3);
    const shorts = entries.find((e) => e.title === "Short selling is here");
    const welcome = entries.find((e) => e.title === "Welcome to Stonker");
    expect(shorts.date).toBe(Date.UTC(2026, 9, 20, 12));
    // Same day: short selling came later, so it sorts first.
    expect(shorts.createdAt).toBeGreaterThan(welcome.createdAt);
  });

  it("is readable by anyone signed in and writable by nobody", async () => {
    const e = await call(admin, "saveDevlogEntry", { title: "Hi", body: "x", date: DAY });
    const stranger = await signUp("stranger");
    expect(await clientRead(stranger, `devlog/${e.id}`)).toBe(200);
    expect(await clientWrite(admin, `devlog/${e.id}`, { title: "hax" })).toBe(403);
  });
});
