import { describe, expect, it } from "vitest";
import { SERVER_CODE_RE, SERVER_COLLECTIONS, isServerCode, randomServerCode } from "../src/servers";
// @ts-expect-error: a plain .mjs script, intentionally not part of any TypeScript project
import { COPIED, SERVER_CODE_RE as SCRIPT_RE, randomServerCode as scriptCode, seededRand } from "../../scripts/migrate-to-servers.mjs";

/** The migration script is plain JS (it can't import the TypeScript in shared/), so keep the two in step. */
describe("migration script stays in step with shared/", () => {
  it("copies exactly the collections a server owns", () => {
    expect([...COPIED].sort()).toEqual([...SERVER_COLLECTIONS].sort());
  });
  it("uses the same server code format and generator", () => {
    expect(SCRIPT_RE.source).toBe(SERVER_CODE_RE.source);
    for (const r of [0, 0.3, 0.999999]) expect(scriptCode(() => r)).toBe(randomServerCode(() => r));
    for (let i = 0; i < 200; i++) expect(isServerCode(scriptCode())).toBe(true);
  });
  it("derives the same code for the same project and name (so a dry run predicts the real one)", () => {
    const a = scriptCode(seededRand("proj:DYF"));
    expect(scriptCode(seededRand("proj:DYF"))).toBe(a);
    expect(scriptCode(seededRand("proj:Other"))).not.toBe(a);
    expect(isServerCode(a)).toBe(true);
  });
});
