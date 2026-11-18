import { describe, expect, it } from "vitest";
import { SERVER_CODE_RE, claimServerCode, isServerCode, randomServerCode, resolveServer, serverPaths, serverUiVisible, withServer } from "../src/servers";

describe("server codes", () => {
  it("accepts exactly six digits with a non-zero first digit", () => {
    for (const ok of ["482915", "100000", "999999"]) expect(isServerCode(ok)).toBe(true);
    for (const bad of ["012345", "12345", "1234567", "48291a", "48 915", "", "../x12", "482915/players", 482915, null, undefined]) {
      expect(isServerCode(bad)).toBe(false);
    }
    expect(SERVER_CODE_RE.test("482915\n")).toBe(false);
  });

  it("always generates valid codes, including at the random extremes", () => {
    expect(randomServerCode(() => 0)).toBe("100000");
    expect(randomServerCode(() => 0.9999999)).toBe("999999");
    for (let i = 0; i < 500; i++) expect(isServerCode(randomServerCode())).toBe(true);
  });

  it("retries with a new code on collision and gives up eventually", async () => {
    let n = 0;
    // First call yields 100000, second 200000 (each code consumes six random() calls).
    const rand = () => (n++ < 6 ? 0 : 0.11);
    const attempts: string[] = [];
    const code = await claimServerCode(async (c) => {
      attempts.push(c);
      return attempts.length > 1; // the first is "taken"
    }, rand);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).not.toBe(attempts[1]);
    expect(code).toBe(attempts[1]);
    await expect(claimServerCode(async () => false, Math.random, 3)).rejects.toThrow();
  });
});

describe("serverPaths", () => {
  it("builds every path under the server", () => {
    const p = serverPaths("482915");
    expect(p.state).toBe("servers/482915/meta/state");
    expect(p.holding("u1", "s1")).toBe("servers/482915/holdings/u1_s1");
    expect(p.privateDiscord).toBe("servers/482915/private/discord");
    expect(p.discordRate).toBe("servers/482915/discordState/rate");
  });
});

describe("resolveServer", () => {
  const base = { requested: null, lastUsed: null, isAdmin: false };
  it("no memberships: none", () => {
    expect(resolveServer({ ...base, memberships: [] })).toEqual({ kind: "none" });
  });
  it("one membership goes straight there, ignoring a stray ?s= and a stale last-used", () => {
    expect(resolveServer({ ...base, memberships: ["111111"], requested: "222222", lastUsed: "333333" })).toEqual({ kind: "server", serverId: "111111" });
  });
  it("several memberships: ?s= wins, then last-used, else the picker", () => {
    const memberships = ["111111", "222222"];
    expect(resolveServer({ ...base, memberships, requested: "222222", lastUsed: "111111" })).toEqual({ kind: "server", serverId: "222222" });
    expect(resolveServer({ ...base, memberships, lastUsed: "111111" })).toEqual({ kind: "server", serverId: "111111" });
    expect(resolveServer({ ...base, memberships, lastUsed: "999999" })).toEqual({ kind: "picker" });
    expect(resolveServer({ ...base, memberships, requested: "999999" })).toEqual({ kind: "picker" });
    expect(resolveServer({ ...base, memberships })).toEqual({ kind: "picker" });
  });
  it("ignores malformed codes", () => {
    expect(resolveServer({ ...base, memberships: ["111111", "222222"], requested: "../x", lastUsed: "0123456" })).toEqual({ kind: "picker" });
  });
  it("admins may open any server by link", () => {
    expect(resolveServer({ ...base, isAdmin: true, memberships: [], requested: "555555" })).toEqual({ kind: "server", serverId: "555555" });
    expect(resolveServer({ ...base, isAdmin: true, memberships: ["111111"], requested: "555555" })).toEqual({ kind: "server", serverId: "555555" });
  });
});

describe("server UI visibility and hrefs", () => {
  it("shows server UI only with two or more memberships", () => {
    expect(serverUiVisible([])).toBe(false);
    expect(serverUiVisible(["111111"])).toBe(false);
    expect(serverUiVisible(["111111", "222222"])).toBe(true);
  });
  it("withServer adds ?s= and keeps queries and hashes; null leaves it alone", () => {
    expect(withServer("/market/", "482915")).toBe("/market/?s=482915");
    expect(withServer("/stock/?id=abc&tab=player", "482915")).toBe("/stock/?id=abc&tab=player&s=482915");
    expect(withServer("/portfolio/#margin", "482915")).toBe("/portfolio/?s=482915#margin");
    expect(withServer("/stock/?s=111111&id=a", "482915")).toBe("/stock/?s=482915&id=a");
    expect(withServer("/market/", null)).toBe("/market/");
    expect(withServer("/market/", "bad")).toBe("/market/");
  });
});
