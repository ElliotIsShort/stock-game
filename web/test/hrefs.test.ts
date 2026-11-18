import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every internal link must carry `?s=` (or not) through ONE place, so a
 * single-membership player never sees it and a multi-server user never loses
 * their server. This scans the web source for hand-built internal hrefs.
 */
const SRC = join(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
/** Source without comments, so prose about `?s=` doesn't count as code. */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = sourceFiles(SRC).map((p) => ({ path: relative(SRC, p), text: stripComments(readFileSync(p, "utf8")) }));
const outside = (allowed: string[]) => files.filter((f) => !allowed.includes(f.path));

describe("internal links go through ServerLink / serverHref", () => {
  it("only ServerLink imports next/link", () => {
    const offenders = outside(["components/ServerLink.tsx"]).filter((f) => /from\s+["']next\/link["']/.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("nothing calls the Next router directly (use useServerRouter)", () => {
    const offenders = outside(["components/ServerLink.tsx", "components/ServerProvider.tsx"]).filter((f) => /\buseRouter\b/.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("no hand-built <a href> to an internal path, and no assigning window.location", () => {
    const offenders = files.filter((f) => /<a\s[^>]*href=["'{`]\s*["'`]?\//.test(f.text) || /window\.location\.(href|assign|replace)\s*[=(]/.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("only the server plumbing writes ?s= or &s= by hand", () => {
    const offenders = outside(["components/ServerProvider.tsx", "components/ServerLink.tsx", "lib/format.ts"]).filter((f) => /[?&]s=/.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("firestore game paths are built from serverPaths, never as bare collection names", () => {
    // Global collections (registrations, admins, users, devlog, auditLog, servers, system) are fine to name directly.
    const gameRoots = ["players", "stocks", "holdings", "shorts", "trades", "posts", "photos", "alerts", "notifications", "weeklyReports", "netWorthHistory", "netWorthSeries", "discordOutbox"];
    const bare = new RegExp(`\\b(collection|doc)\\(\\s*[\\w.()]+\\s*,\\s*["'\`](${gameRoots.join("|")}|meta|config|content)\\b`);
    const offenders = files.filter((f) => bare.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("per-server client storage keys are namespaced by server id", () => {
    const offenders = outside(["lib/serverStore.ts"]).filter((f) => /["'`]fsm:(recap|previous|resultsSeen|viewAsPlayer)/.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
    const store = files.find((f) => f.path === "lib/serverStore.ts")!.text;
    for (const key of ["recap", "previous", "resultsSeen"]) expect(store).toMatch(new RegExp(`${key}: \\(serverId: string, uid: string\\) => \`fsm:${key}:\\$\\{serverId\\}:`));
    expect(store).toMatch(/viewAsPlayer: \(serverId: string\) => `fsm:viewAsPlayer:\$\{serverId\}`/);
  });
});
