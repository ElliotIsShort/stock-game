// Temporary end-to-end check against the local emulators. Deleted after use.
const P = "demo-fsm";
const FN = `http://127.0.0.1:5001/${P}/europe-west2`;
const FS = `http://127.0.0.1:8180/v1/projects/${P}/databases/(default)/documents`;
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";

async function signUp(email) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123", returnSecureToken: true }),
  });
  const j = await r.json();
  return { uid: j.localId, token: j.idToken };
}
async function call(user, name, data) {
  const r = await fetch(`${FN}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${user.token}` },
    body: JSON.stringify({ data }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${j.error.status} ${j.error.message}`);
  return j.result;
}
async function expectFail(p, label) {
  try { await p; console.log("UNEXPECTED SUCCESS", label); process.exitCode = 1; }
  catch (e) { console.log("ok rejected:", label, "→", e.message); }
}
function val(v) {
  if ("doubleValue" in v) return v.doubleValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, val(x)]));
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(val);
  return v;
}
async function get(path) {
  const r = await fetch(`${FS}/${path}`, { headers: { authorization: "Bearer owner" } });
  const j = await r.json();
  return j.fields ? val({ mapValue: { fields: j.fields } }) : null;
}
async function list(coll) {
  const r = await fetch(`${FS}/${coll}?pageSize=300`, { headers: { authorization: "Bearer owner" } });
  const j = await r.json();
  return (j.documents ?? []).map((d) => val({ mapValue: { fields: d.fields } }));
}
async function clientGet(user, path) {
  const r = await fetch(`${FS}/${path}`, { headers: { authorization: `Bearer ${user.token}` } });
  return r.status;
}
const round = (n) => Math.round(n * 100) / 100;

const a = await signUp("alice@example.com");
const b = await signUp("bob@example.com");
const c = await signUp("cara@example.com");
await fetch(`${FS}/admins/${a.uid}`, { method: "PATCH", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: JSON.stringify({ fields: {} }) });

await call(a, "register", { displayName: "Alice" });
await call(b, "register", { displayName: "Bob" });
await expectFail(call(c, "register", { displayName: "bob" }), "duplicate name");
await call(c, "register", { displayName: "Cara" });
await expectFail(call(b, "approvePlayer", { uid: c.uid }), "non-admin approve");
console.log("rules: pending user reads stocks →", await clientGet(c, "stocks/x"));

for (const u of [a, b, c]) console.log("approve", JSON.stringify(await call(a, "approvePlayer", { uid: u.uid })));
console.log("rules: player reads players →", await clientGet(b, `players/${a.uid}`));
const w = await fetch(`${FS}/players/${b.uid}`, { method: "PATCH", headers: { authorization: `Bearer ${b.token}`, "content-type": "application/json" }, body: JSON.stringify({ fields: { cash: { doubleValue: 1e9 } } }) });
console.log("rules: client write cash →", w.status);

await expectFail(call(a, "trade", { stockId: a.uid, side: "buy", amount: 10 }), "own stock");
await expectFail(call(b, "trade", { stockId: a.uid, side: "buy", amount: 5000 }), "insufficient cash");
const t1 = await call(b, "trade", { stockId: a.uid, side: "buy", amount: 100, postText: "she's buying drinks tonight" });
console.log("B buys £100 Alice:", round(t1.shares), "shares, fee", t1.fee, "price", round(t1.priceBefore), "→", round(t1.priceAfter));
const t2 = await call(c, "trade", { stockId: a.uid, side: "buy", amount: 200 });
const t3 = await call(b, "trade", { stockId: a.uid, side: "sell", amount: t1.shares / 2 });
console.log("B sells half: got", round(t3.netCash), "price →", round(t3.priceAfter));
await call(a, "trade", { stockId: b.uid, side: "buy", amount: 300 });
await expectFail(call(b, "trade", { stockId: a.uid, side: "sell", amount: 999 }), "oversell");
await expectFail(call(a, "createPost", { text: "hi", linkedTradeId: t2.id }), "link someone else's trade");
const post = await call(b, "createPost", { text: "I'm a great investment", taggedStockId: b.uid });
await call(c, "toggleReaction", { postId: post.id, reaction: "laugh" });
await call(a, "toggleReaction", { postId: post.id, reaction: "laugh" });
console.log("post reactions", (await get(`posts/${post.id}`)).reactionCount);
await call(c, "createPost", { text: "why not", linkedTradeId: t2.id });

const state1 = await get("meta/state");
console.log("state before close", JSON.stringify(state1));

const bad = await fetch(`${FN}/weeklyCloseCron`, { method: "POST", headers: { authorization: "Bearer nope" } });
console.log("cron bad secret →", bad.status);
const cron = await fetch(`${FN}/weeklyCloseCron`, { method: "POST", headers: { authorization: "Bearer local-emulator-secret-123456" } });
console.log("cron close →", cron.status, await cron.text());
const cron2 = await fetch(`${FN}/weeklyCloseCron`, { method: "POST", headers: { authorization: "Bearer local-emulator-secret-123456" } });
console.log("cron again →", await cron2.text());

const rep = await get("weeklyReports/week-0001");
console.log("report money", JSON.stringify(rep.money));
console.log("report winner", JSON.stringify(rep.highlights.winner));
console.log("report growth", JSON.stringify(rep.highlights.growth.map((g) => [g.name, round(g.weeklyGrowth * 10000) / 10000, round(g.bonus)])));
console.log("report activity", JSON.stringify(rep.activity));
console.log("report flags", JSON.stringify(rep.flags));
console.log("markdown head:\n" + rep.markdown.split("\n").slice(0, 4).join("\n"));

// Sum check: total player cash change = allowances + bonuses + prize - (spent into pools net)
const players = await list("players");
for (const p of players) console.log("player", p.displayName, "cash", round(p.cash), "allow", p.totalAllowances, "bonus", round(p.totalBonus), "nwStart", round(p.netWorthWeekStart));
const state2 = await get("meta/state");
console.log("state after", JSON.stringify(state2));

await expectFail(call(a, "runWeeklyClose", { expectedWeek: 1 }), "stale expectedWeek");
console.log("admin close wk2", JSON.stringify(await call(a, "runWeeklyClose", { expectedWeek: 2 })));
const rep2 = await get("weeklyReports/week-0002");
console.log("wk2 changes", JSON.stringify(rep2.changes));

// Newcomer joining in week 3 gets base + 2 allowances, lists at median.
const d = await signUp("dan@example.com");
await call(d, "register", { displayName: "Dan" });
console.log("approve Dan", JSON.stringify(await call(a, "approvePlayer", { uid: d.uid })));

await call(a, "updateConfig", { patch: { tradingFeePct: 0.02 } });
await expectFail(call(a, "updateConfig", { patch: { tradingFeePct: 5 } }), "bad config");
await expectFail(call(a, "updateConfig", { patch: { nope: 1 } }), "unknown config key");
console.log("config fee", (await get("config/global")).tradingFeePct);

const bBefore = (await get(`players/${b.uid}`)).cash;
const del = await call(a, "delistPlayer", { uid: a.uid });
console.log("delist Alice payouts", JSON.stringify(del.payouts.map((x) => round(x.cash))));
console.log("Bob cash", round(bBefore), "→", round((await get(`players/${b.uid}`)).cash));
await expectFail(call(b, "trade", { stockId: a.uid, side: "buy", amount: 10 }), "trade delisted");
await call(a, "deletePost", { postId: post.id, reason: "test" });
console.log("post deleted", (await get(`posts/${post.id}`)) === null);
console.log("audit entries", (await list("auditLog")).map((e) => e.action).join(","));
