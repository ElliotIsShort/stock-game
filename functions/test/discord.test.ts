import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, clientRead, expectCallError, getDoc, listDocs, makeAdmin, makeServer, registerUser, wipeEmulators, SERVER, type User } from "./helpers";

/**
 * Each server's webhook points at this capture server (path = the server id),
 * so we can assert exactly what Discord would receive, and where.
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
        received.push({ ...JSON.parse(body), _path: req.url });
      } catch {
        received.push({ raw: body, _path: req.url });
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

const urlFor = (serverId: string) => `http://127.0.0.1:${PORT}/${serverId}`;

async function waitForOutbox(pred: (d: any) => boolean, count: number, ms = 15_000, serverId?: string): Promise<any[]> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const docs = (await listDocs("discordOutbox", serverId)).filter(pred);
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
  // Set the webhook before approving, so the listing posts are captured.
  const users = [await registerUser("Dana Admin"), await registerUser("Dana Doe"), await registerUser("Eli Evans")];
  [admin, dana, eli] = users;
  await makeAdmin(admin);
  const serverId = await makeServer(admin);
  await call(admin, "setDiscordWebhook", { url: urlFor(serverId) });
  for (const u of users) await call(admin, "approvePlayer", { uid: u.uid });
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

describe("per-server webhooks", () => {
  it("setDiscordWebhook validates the URL, is admin-only and never exposes the URL", async () => {
    await expectCallError(call(dana, "setDiscordWebhook", { url: urlFor(SERVER) }), "PERMISSION_DENIED");
    for (const bad of ["https://example.com/api/webhooks/1/x", "http://evil.com/api/webhooks/1/x", "not a url", "https://discord.com/other/path", 42]) {
      await expectCallError(call(admin, "setDiscordWebhook", { url: bad }), "INVALID_ARGUMENT");
    }
    expect(await call(admin, "setDiscordWebhook", { url: "https://discord.com/api/webhooks/123/abc" })).toEqual({ ok: true, set: true });
    expect(await call(admin, "setDiscordWebhook", { url: urlFor(SERVER) })).toEqual({ ok: true, set: true });
    expect((await getDoc(`servers/${SERVER}`)).hasDiscordWebhook).toBe(true);
    expect((await getDoc("private/discord")).webhookUrl).toBe(urlFor(SERVER));
    expect(await listDocs("private")).toHaveLength(1);
    // Neither the admin nor a member can read the webhook document, and nobody can write it.
    expect(await clientRead(admin, "private/discord")).toBe(403);
    expect(await clientRead(dana, "private/discord")).toBe(403);
    const audit = (await listDocs("auditLog")).find((a) => a.action === "setDiscordWebhook");
    expect(audit).toMatchObject({ serverId: SERVER, details: { set: true } });
    expect(JSON.stringify(audit)).not.toContain("127.0.0.1");
    // Clearing it.
    expect(await call(admin, "setDiscordWebhook", { url: "" })).toEqual({ ok: true, set: false });
    expect((await getDoc(`servers/${SERVER}`)).hasDiscordWebhook).toBe(false);
    expect(await getDoc("private/discord")).toBeNull();
  });

  it("a server with no webhook marks its outbox items skipped", async () => {
    const other = await makeServer(admin, "Other server", { switchTo: false });
    await call(admin, "addPlayerToServer", { uid: admin.uid, serverId: other, displayName: "Admin Two" });
    await waitForOutbox((d) => d.kind === "listing" && d.status === "skipped", 1, 15_000, other);
    expect((await listDocs("discordOutbox", other)).every((d) => d.status === "skipped")).toBe(true);
  });

  it("an event in one server never reaches another server's webhook, with or without its own", async () => {
    const a = SERVER;
    const b = await makeServer(admin, "Server B", { switchTo: false });
    await call(admin, "updateConfig", { patch: { discordBigTradePct: 0.05 } , serverId: b });
    // B has no webhook yet: its events are skipped and A's channel hears nothing.
    await call(admin, "addPlayerToServer", { uid: admin.uid, serverId: b, displayName: "Bee Admin" });
    await call(admin, "addPlayerToServer", { uid: dana.uid, serverId: b, displayName: "Bee Dana" });
    await waitForOutbox((d) => d.kind === "listing" && d.status === "skipped", 2, 15_000, b);
    await call(dana, "trade", { stockId: admin.uid, side: "buy", amount: 200, serverId: b });
    await waitForOutbox((d) => d.kind === "bigTrade" && d.status === "skipped", 1, 15_000, b);
    expect(received.some((r) => r._path !== `/${a}`)).toBe(false);
    expect(received.some((r) => JSON.stringify(r).includes("Bee Dana"))).toBe(false);

    // Give B its own webhook: now B's events go to B's path only, and A's go to A's.
    await call(admin, "setDiscordWebhook", { url: urlFor(b), serverId: b });
    received = [];
    await call(dana, "trade", { stockId: admin.uid, side: "buy", amount: 200, serverId: b });
    await call(eli, "trade", { stockId: dana.uid, side: "buy", amount: 200, serverId: a });
    await waitFor((r) => r._path === `/${b}` && String(r.embeds?.[0]?.title).startsWith("Big buy"));
    await waitFor((r) => r._path === `/${a}` && String(r.embeds?.[0]?.title).startsWith("Big buy"));
    await new Promise((r) => setTimeout(r, 500));
    expect(received.filter((r) => r._path === `/${a}` && JSON.stringify(r).includes("Bee")).length).toBe(0);
    expect(received.filter((r) => r._path === `/${b}` && JSON.stringify(r).includes("Eli Evans")).length).toBe(0);
  });

  it("an archived server posts nothing", async () => {
    await call(admin, "archiveServer", {});
    // Mutations are rejected, so seed an outbox item directly the way a trigger would see it.
    const { patchDoc } = await import("./helpers");
    await patchDoc("discordOutbox/archived-item", { id: "archived-item", priority: "high", kind: "listing", status: "pending", createdAt: Date.now(), message: { title: "Should not post", description: "x" } as never });
    await waitForOutbox((d) => d.id === "archived-item" && d.status === "skipped", 1);
    expect(received.some((r) => JSON.stringify(r).includes("Should not post"))).toBe(false);
  });
});
