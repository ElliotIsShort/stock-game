#!/usr/bin/env node
/**
 * One-off migration: the current (single-game) data becomes the FIRST server.
 *
 *   node scripts/migrate-to-servers.mjs --project <id> --name DYF --backup-dir ./backup            # dry run
 *   node scripts/migrate-to-servers.mjs --project <id> --name DYF --backup-dir ./backup --execute  # for real
 *
 * Safety, in order of importance:
 *  - COPY, never move. The legacy top-level collections are left exactly as
 *    they are (they are the rollback copy; new code and the rules ignore them).
 *  - Dry run by default: reads only, writes nothing (no Firestore, no files).
 *  - Refuses to run unless maintenance mode is on (so nothing is writing) and
 *    the next weekly close is more than 2 hours away.
 *  - A full local JSON backup of every top-level collection comes before any write.
 *  - Never overwrites: a destination document that already exists is left alone.
 *    If it differs from the legacy one that is reported as a conflict (FAIL), not
 *    "fixed". Re-running after a partial failure only fills in what is missing.
 *  - Verifies counts, every document, and checksum totals (cash, pools, prices,
 *    prize pool, week) and exits non-zero on any mismatch.
 *
 * Credentials: Application Default Credentials (`gcloud auth application-default
 * login`), or FIRESTORE_EMULATOR_HOST for the emulator.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationDefault, getApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";

// ---------- Constants (kept in step with shared/src/servers.ts by a test) ----------

/** The 17 collections that become `servers/{code}/<name>`. */
export const COPIED = [
  "config", "content", "meta", "players", "stocks", "holdings", "shorts", "trades", "posts", "photos", "alerts", "notifications",
  "discordOutbox", "discordState", "netWorthHistory", "netWorthSeries", "weeklyReports",
];
/** Global collections that stay where they are. */
export const LEFT_IN_PLACE = ["registrations", "admins", "devlog", "auditLog"];
export const MIN_LEAD_MS = 2 * 60 * 60 * 1000;
export const SERVER_CODE_RE = /^[1-9][0-9]{5}$/;

/** First digit 1-9, then five digits (same as `randomServerCode` in shared/). `rand` returns [0,1). */
export function randomServerCode(rand = Math.random) {
  const first = 1 + Math.floor(rand() * 9);
  let rest = "";
  for (let i = 0; i < 5; i++) rest += String(Math.min(9, Math.floor(rand() * 10)));
  return `${Math.min(9, first)}${rest}`;
}

/** A small seeded PRNG, so the dry run and the real run pick the SAME code for the same project and name. */
export function seededRand(seed) {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Helpers ----------

/** Plain, comparable, JSON-able form of a Firestore value. */
export function normalise(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Timestamp) return { __timestamp: [v.seconds, v.nanoseconds] };
  if (typeof v.path === "string" && typeof v.firestore === "object") return { __ref: v.path };
  if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return v.map((x) => normalise(x) ?? null);
  const out = {};
  for (const k of Object.keys(v).sort()) {
    const n = normalise(v[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}
const same = (a, b) => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

/** Every document of a collection, paged by id so large collections don't need one giant read. */
async function readAll(col) {
  const out = [];
  let last;
  for (;;) {
    let q = col.orderBy(FieldPath.documentId()).limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const d of snap.docs) out.push({ id: d.id, ref: d.ref, data: d.data() });
    if (snap.size < 500) return out;
    last = snap.docs[snap.docs.length - 1];
  }
}

/** A collection and everything under it, as plain JSON (for the backup). */
async function dump(col, counter) {
  const docs = [];
  for (const d of await readAll(col)) {
    const entry = { id: d.id, data: normalise(d.data) };
    const subs = await d.ref.listCollections();
    if (subs.length) {
      entry.collections = {};
      for (const s of subs) entry.collections[s.id] = await dump(s, counter);
    }
    counter.n++;
    docs.push(entry);
  }
  return docs;
}

const sum = (rows, pick) => rows.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).reduce((t, r) => t + (Number(pick(r.data)) || 0), 0);

/** The numbers that must be identical before and after. */
export function checksums(c) {
  const state = (c.meta ?? []).find((d) => d.id === "state")?.data ?? {};
  return {
    playersCash: sum(c.players ?? [], (d) => d.cash),
    stocksPoolCash: sum(c.stocks ?? [], (d) => d.poolCash),
    stocksPoolShares: sum(c.stocks ?? [], (d) => d.poolShares),
    stocksPrice: sum(c.stocks ?? [], (d) => d.price),
    prizePool: state.prizePool ?? null,
    currentWeek: state.currentWeek ?? null,
  };
}

// ---------- The migration ----------

/**
 * @param {object} o
 * @param {import("firebase-admin/firestore").Firestore} o.db
 * @param {string} o.project   used only to seed the (deterministic) server code
 * @param {string} o.name      the first server's display name
 * @param {string} [o.backupDir]  required with execute
 * @param {boolean} [o.execute]   false = dry run (the default)
 * @param {number} [o.now]
 * @param {(line: string) => void} [o.log]
 */
export async function migrate({ db, project, name, backupDir, execute = false, now = Date.now(), log = console.log }) {
  const say = (s = "") => log(s);
  const result = { ok: false, dryRun: !execute, serverId: null, counts: {}, problems: [], totals: null };
  const problem = (s) => {
    result.problems.push(s);
    say(`  ✖ ${s}`);
  };
  if (!name || name.trim().length < 2) throw new Error("--name is required (the first server's display name).");
  if (execute && !backupDir) throw new Error("--backup-dir is required with --execute.");
  say(execute ? "=== MIGRATION (live run) ===" : "=== MIGRATION DRY RUN: nothing will be written ===");

  // ---- Prerequisites (reads only) ----
  say("\n[1/5] Prerequisites");
  const maint = await db.doc("system/maintenance").get();
  const maintenanceOn = maint.exists && maint.data().enabled === true;
  say(`  ${maintenanceOn ? "✔" : "✖"} maintenance mode is ${maintenanceOn ? "on" : "OFF"}`);
  if (!maintenanceOn) result.problems.push("Maintenance mode is off. Turn it on in Admin first, so nothing is writing.");
  const stateSnap = await db.doc("meta/state").get();
  const closesAt = stateSnap.exists ? stateSnap.data().closesAt : undefined;
  if (typeof closesAt !== "number") {
    say("  ✖ legacy meta/state has no closesAt");
    result.problems.push("Legacy meta/state has no closesAt (it is set once the scheduler or a player's session runs).");
  } else {
    const leadMin = Math.round((closesAt - now) / 60_000);
    const ok = closesAt - now > MIN_LEAD_MS;
    say(`  ${ok ? "✔" : "✖"} next weekly close is in ${leadMin} minutes (needs more than ${MIN_LEAD_MS / 60_000})`);
    if (!ok) result.problems.push("The weekly close is within 2 hours (or overdue). Migrate well away from it.");
  }
  if (execute && result.problems.length) throw new Error(`Refusing to run:\n  - ${result.problems.join("\n  - ")}`);

  // ---- Backup (reads; files only with --execute) ----
  say(`\n[2/5] Backup of every top-level collection${execute ? ` → ${resolve(backupDir)}` : " (dry run: counted, not written)"}`);
  const top = await db.listCollections();
  const backup = {};
  for (const col of top) {
    const counter = { n: 0 };
    backup[col.id] = await dump(col, counter); // any read failure throws: we abort
    result.counts[col.id] = counter.n;
    say(`  ${col.id.padEnd(18)} ${String(counter.n).padStart(6)} documents`);
  }
  if (execute) {
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    for (const [id, docs] of Object.entries(backup)) writeFileSync(join(backupDir, `${stamp}-${id}.json`), JSON.stringify(docs, null, 1));
    writeFileSync(join(backupDir, `${stamp}-manifest.json`), JSON.stringify({ project, takenAt: now, counts: result.counts }, null, 2));
    say(`  wrote ${top.length} file(s) plus a manifest`);
  }

  // Legacy documents with sub-collections can't be copied by this script: stop rather than lose them.
  for (const c of COPIED) {
    for (const d of backup[c] ?? []) {
      if (d.collections) throw new Error(`${c}/${d.id} has sub-collections, which this script doesn't copy. Aborting.`);
    }
  }
  // Re-read as live Firestore data (Timestamps and all) for the actual copy; the backup is JSON.
  const legacy = {};
  for (const c of COPIED) legacy[c] = await readAll(db.collection(c));

  // ---- Which server? (the same one on a re-run) ----
  say("\n[3/5] Plan");
  let serverId;
  const existing = await db.collection("servers").where("migration.source", "==", "legacy").get();
  if (existing.size > 1) throw new Error("More than one server is marked as migrated from the legacy data. Resolve that by hand first.");
  if (existing.size === 1) {
    serverId = existing.docs[0].id;
    say(`  reusing server ${serverId} (a previous run created it)`);
  } else {
    const rand = seededRand(`${project}:${name.trim()}`);
    for (let i = 0; i < 200 && !serverId; i++) {
      const code = randomServerCode(rand);
      if (!(await db.doc(`servers/${code}`).get()).exists) serverId = code;
    }
    if (!serverId) throw new Error("Couldn't find a free server code.");
    say(`  new server code: ${serverId}  (name “${name.trim()}”)`);
  }
  result.serverId = serverId;
  const dest = {};
  const plan = {};
  for (const c of COPIED) {
    dest[c] = await readAll(db.collection(`servers/${serverId}/${c}`));
    const have = new Map(dest[c].map((d) => [d.id, d.data]));
    const p = { create: 0, same: 0, conflict: 0 };
    for (const d of legacy[c]) {
      if (!have.has(d.id)) p.create++;
      else if (same(have.get(d.id), d.data)) p.same++;
      else p.conflict++;
    }
    plan[c] = p;
    say(`  ${c.padEnd(18)} ${String(legacy[c].length).padStart(6)} legacy → create ${p.create}, already there ${p.same}${p.conflict ? `, CONFLICT ${p.conflict}` : ""}`);
    if (p.conflict) problem(`${c}: ${p.conflict} document(s) already exist in the new place with different data. They will NOT be overwritten.`);
  }
  const players = legacy.players;
  say(`  users/{uid} lookup docs for ${players.length} player(s): serverIds ⊇ [${serverId}]`);
  say(`  legacy collections left untouched: ${[...COPIED, ...LEFT_IN_PLACE].join(", ")}`);
  const legacyState = legacy.meta.find((d) => d.id === "state")?.data;
  if (!legacyState) problem("meta/state is missing from the legacy data.");

  if (!execute) {
    say("\nDry run finished. Nothing was written.");
    if (result.problems.length) say("Fix the ✖ items above before running with --execute.");
    result.ok = result.problems.length === 0;
    return result;
  }

  // Something already in the new place disagrees with the legacy data (e.g. activity after a cutover):
  // never overwrite it, and don't half-copy around it.
  if (result.problems.length) throw new Error(`Refusing to write:\n  - ${result.problems.join("\n  - ")}`);

  // ---- Copy ----
  say("\n[4/5] Copy");
  const serverRef = db.doc(`servers/${serverId}`);
  const serverDoc = (await serverRef.get()).data();
  if (!serverDoc) {
    await serverRef.create({ slug: serverId, name: name.trim(), status: "active", createdAt: now, closesAt: legacyState.closesAt, hasDiscordWebhook: false, migration: { source: "legacy", status: "in_progress", startedAt: now } });
    say(`  created servers/${serverId}`);
  }
  const writer = db.bulkWriter();
  writer.onWriteError((err) => err.failedAttempts < 6); // retry transient failures
  let written = 0;
  const pending = [];
  for (const c of COPIED) {
    const have = new Set(dest[c].map((d) => d.id));
    for (const d of legacy[c]) {
      if (have.has(d.id)) continue; // never overwrite
      pending.push(
        writer.create(db.doc(`servers/${serverId}/${c}/${d.id}`), d.data).then(
          () => void written++,
          (err) => {
            if (err.code === 6) return; // ALREADY_EXISTS: a parallel run got there first; verification decides
            throw err;
          },
        ),
      );
    }
  }
  for (const p of players) {
    pending.push(writer.set(db.doc(`users/${p.id}`), { serverIds: FieldValue.arrayUnion(serverId) }, { merge: true }));
  }
  await writer.close();
  await Promise.all(pending);
  say(`  wrote ${written} document(s) + ${players.length} users docs`);
  await serverRef.update({ closesAt: legacyState.closesAt, status: "active" });

  // ---- Verify ----
  say("\n[5/5] Verify");
  const after = {};
  let allGood = result.problems.length === 0;
  for (const c of COPIED) {
    after[c] = await readAll(db.collection(`servers/${serverId}/${c}`));
    const countOk = after[c].length === legacy[c].length;
    const have = new Map(after[c].map((d) => [d.id, d.data]));
    const bad = legacy[c].filter((d) => !have.has(d.id) || !same(have.get(d.id), d.data));
    const ok = countOk && bad.length === 0;
    allGood &&= ok;
    say(`  ${ok ? "✔" : "✖"} ${c.padEnd(18)} ${legacy[c].length} → ${after[c].length}${bad.length ? `  (${bad.length} missing or different, e.g. ${bad[0].id})` : ""}`);
    if (!ok) result.problems.push(`${c}: counts or contents differ`);
  }
  for (const p of players) {
    const u = (await db.doc(`users/${p.id}`).get()).data();
    if (!u?.serverIds?.includes(serverId)) {
      allGood = false;
      result.problems.push(`users/${p.id} doesn't list the server`);
      say(`  ✖ users/${p.id} doesn't list ${serverId}`);
    }
  }
  const before = checksums(Object.fromEntries(COPIED.map((c) => [c, legacy[c]])));
  const afterSums = checksums(after);
  result.totals = { before, after: afterSums };
  for (const k of Object.keys(before)) {
    const ok = before[k] === afterSums[k];
    allGood &&= ok;
    say(`  ${ok ? "✔" : "✖"} total ${k.padEnd(18)} ${before[k]} → ${afterSums[k]}`);
    if (!ok) result.problems.push(`total ${k} differs`);
  }
  const serverClosesAt = (await serverRef.get()).data().closesAt;
  if (serverClosesAt !== legacyState.closesAt) {
    allGood = false;
    result.problems.push("servers/{id}.closesAt doesn't match meta/state.closesAt");
  }
  if (allGood) {
    await serverRef.update({ "migration.status": "complete", "migration.completedAt": Date.now(), "migration.counts": result.counts });
  }
  result.ok = allGood;
  say(`\n${allGood ? "PASS" : "FAIL"}: server ${serverId} ${allGood ? "holds an exact copy of the legacy data" : "does NOT match the legacy data. Do not cut over."}`);
  if (allGood) say("Legacy collections were not touched; they are your rollback copy.");
  return result;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") out.execute = true;
    else if (a === "--project" || a === "--name" || a === "--backup-dir") out[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

export function connect(project) {
  const app = getApps().length ? getApp() : initializeApp({ projectId: project, ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }) });
  return getFirestore(app);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.project) throw new Error("--project is required.");
    const db = connect(args.project);
    console.log(`Project: ${args.project}${process.env.FIRESTORE_EMULATOR_HOST ? " (emulator)" : ""}`);
    const res = await migrate({ db, project: args.project, name: args.name, backupDir: args.backupDir, execute: args.execute });
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
