#!/usr/bin/env node
/**
 * Deletes the LEGACY top-level game collections that `migrate-to-servers.mjs`
 * left behind as the rollback copy. Run it only after the new setup has proven
 * itself for a couple of weeks: afterwards there is no going back.
 *
 *   node scripts/delete-legacy.mjs --project <id>
 *
 * It asks you to type a confirmation phrase, and refuses unless the first
 * server's migration is marked complete. It never touches `servers`, `users`,
 * `registrations`, `admins`, `devlog` or `auditLog`.
 *
 * Make a fresh backup first if you haven't lately (e.g. `gcloud firestore export`).
 */
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { COPIED, LEFT_IN_PLACE, connect } from "./migrate-to-servers.mjs";

/** The exact words that must be typed. Includes the project, so a muddled terminal can't confirm the wrong one. */
export const confirmationPhrase = (project) => `delete legacy data in ${project}`;

/**
 * @param {object} o
 * @param {import("firebase-admin/firestore").Firestore} o.db
 * @param {string} o.project
 * @param {string} o.typed   what the person typed
 */
export async function deleteLegacy({ db, project, typed, log = console.log }) {
  if (typed !== confirmationPhrase(project)) throw new Error(`Confirmation phrase didn't match. Nothing was deleted.`);
  const migrated = await db.collection("servers").where("migration.source", "==", "legacy").get();
  if (migrated.size !== 1 || migrated.docs[0].data().migration?.status !== "complete") {
    throw new Error("No completed migration found (servers/<code>.migration.status must be \"complete\"). Nothing was deleted.");
  }
  const serverId = migrated.docs[0].id;
  // Belt and braces: the new copy must still have as many documents as the legacy collections we are about to remove.
  for (const c of COPIED) {
    const legacy = (await db.collection(c).count().get()).data().count;
    const now = (await db.collection(`servers/${serverId}/${c}`).count().get()).data().count;
    if (legacy > now) throw new Error(`${c}: the legacy collection has ${legacy} documents but server ${serverId} only ${now}. Nothing was deleted.`);
  }
  const deleted = {};
  for (const c of COPIED) {
    deleted[c] = (await db.collection(c).count().get()).data().count;
    await db.recursiveDelete(db.collection(c));
    log(`  deleted ${c} (${deleted[c]} documents)`);
  }
  log(`Kept: servers, users, ${LEFT_IN_PLACE.join(", ")}.`);
  return { serverId, deleted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const i = process.argv.indexOf("--project");
    const project = i >= 0 ? process.argv[i + 1] : undefined;
    if (!project) throw new Error("--project is required.");
    const db = connect(project);
    console.log(`This permanently deletes the old top-level game data in project "${project}": ${COPIED.join(", ")}.`);
    console.log("The new servers are not touched, but you will no longer be able to roll back to the old layout.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question(`Type "${confirmationPhrase(project)}" to continue: `);
    rl.close();
    await deleteLegacy({ db, project, typed });
    console.log("Done.");
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
