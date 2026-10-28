import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, clientRead, expectCallError, getDoc, listDocs, setupPlayers, wipeEmulators, type User } from "./helpers";

/**
 * The emulator's DISCORD_WEBHOOK_URL (scripts/ensure-test-secret.mjs) points
 * at this capture server, so we can assert exactly what Discord would receive.
 */
const PORT = 8199;
let server: Server;
let received: any[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({ raw: body });
      }
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Wait for a captured webhook body matching `pred` (triggers run asynchronously). */
async function waitFor(pred: (b: any) => boolean, ms = 15_000): Promise<any> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = received.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No matching Discord post. Got: ${JSON.stringify(received.map((b) => b.embeds?.[0]?.title))}`);
}

async function waitForOutbox(pred: (d: any) => boolean, count: number, ms = 15_000): Promise<any[]> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const docs = (await listDocs("discordOutbox")).filter(pred);
    if (docs.length >= count) return docs;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Outbox items didn't reach the expected state");
}

const DISCORD_ID = "123456789012345678";
let admin: User;
let dana: User;
let eli: User;

beforeEach(async () => {
  await wipeEmulators();
  received = [];
  [admin, dana, eli] = await setupPlayers("Dana Admin", "Dana Doe", "Eli Evans");
  await call(admin, "updateConfig", { patch: { discordBigTradePct: 0.05, discordMaxPerHour: 100 } });
});

describe("Discord webhook", () => {
  it("posts new listings straight away", async () => {
    const body = await waitFor((b) => b.embeds?.[0]?.title === "New listing: Eli Evans ($ELI)");
    expect(body.content).toBe("Welcome to the market, **Eli Evans**!");
    expect(body.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it("lets players link their Discord ID and @mentions them on big trades", async () => {
    await expectCallError(call(dana, "setDiscordId", { discordId: "not-an-id" }), "INVALID_ARGUMENT");
    await call(dana, "setDiscordId", { discordId: DISCORD_ID });
    expect((await getDoc(`players/${dana.uid}`)).discordId).toBe(DISCORD_ID);
    await expectCallError(call(eli, "setDiscordId", { discordId: DISCORD_ID }), "ALREADY_EXISTS");

    await call(eli, "trade", { stockId: dana.uid, side: "buy", amount: 100, postText: "Dana's on fire @everyone" });
    // "Dana Admin" listed first and took DAN, so Dana Doe defaulted to DOE.
    const body = await waitFor((b) => b.embeds?.[0]?.title?.startsWith("Big buy · $DOE"));
    expect(body.content).toBe(`<@${DISCORD_ID}>, Eli Evans just bought £100.00 of your stock.`);
    expect(body.allowed_mentions).toEqual({ parse: [], users: [DISCORD_ID] });
    expect(body.embeds[0].description).toContain("> Dana's on fire @everyone");

    // Small trades aren't posted.
    await call(eli, "trade", { stockId: dana.uid, side: "buy", amount: 1 });
    await call(dana, "setDiscordId", { discordId: null });
    expect((await getDoc(`players/${dana.uid}`)).discordId).toBeUndefined();
    const items = await listDocs("discordOutbox");
    expect(items.filter((i) => i.kind === "bigTrade")).toHaveLength(1);
  });

  it("holds routine posts back past the hourly limit and digests them", async () => {
    await call(admin, "updateConfig", { patch: { discordMaxPerHour: 0 } });
    await call(eli, "trade", { stockId: dana.uid, side: "buy", amount: 100 });
    await call(dana, "trade", { stockId: eli.uid, side: "buy", amount: 100 });
    await waitForOutbox((d) => d.kind === "bigTrade" && d.status === "queued", 2);

    await expectCallError(call(dana, "sendDiscordDigest"), "PERMISSION_DENIED");
    expect(await call(admin, "sendDiscordDigest")).toEqual({ sent: 2 });
    const body = await waitFor((b) => b.embeds?.[0]?.title === "Busy market: 2 more updates");
    expect(body.content).toBeUndefined();
    expect(body.embeds[0].description).toContain("Big buy · $DOE");
    expect((await listDocs("discordOutbox")).filter((d) => d.status === "digested")).toHaveLength(2);
  });

  it("posts the weekly close with winners and awards", async () => {
    await call(eli, "trade", { stockId: dana.uid, side: "buy", amount: 200 });
    await call(admin, "runWeeklyClose", { expectedWeek: 1 });
    const body = await waitFor((b) => b.embeds?.[0]?.title === "🔔 Week 1 closed");
    // Eli's shares are marked above what he paid, so he out-grows Dana's small CEO bonus.
    expect(body.embeds[0].description).toContain("🥇 **Eli Evans**");
    expect(body.embeds[0].fields.map((f: any) => f.name)).toEqual(["Market index", "Awards"]);
    expect(body.embeds[0].fields[1].value).toContain("🚀 **Biggest Mover**: **Dana Doe**");
  });

  it("can be switched off in config", async () => {
    await call(admin, "updateConfig", { patch: { discordEnabled: 0 } });
    await call(eli, "trade", { stockId: dana.uid, side: "buy", amount: 100 });
    const [item] = await waitForOutbox((d) => d.kind === "bigTrade" && d.status === "skipped", 1);
    expect(item.status).toBe("skipped");
  });

  it("admins can send a test message; the outbox is never readable by clients", async () => {
    await expectCallError(call(dana, "testDiscord"), "PERMISSION_DENIED");
    expect(await call(admin, "testDiscord")).toEqual({ ok: true });
    await waitFor((b) => b.embeds?.[0]?.title === "✅ Stonker is connected");
    const [item] = await listDocs("discordOutbox");
    expect(await clientRead(admin, `discordOutbox/${item.id}`)).toBe(403);
    expect(await clientRead(admin, "discordState/rate")).toBe(403);
  });
});
