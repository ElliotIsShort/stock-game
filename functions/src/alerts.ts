import { HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import {
  alertFires,
  alertMessage,
  alertSummary,
  validateAlert,
  type AppNotification,
  type Player,
  type PriceAlert,
  type Stock,
} from "@fsm/shared";
import { gameCall, gameCtx, inMaintenance, db, readConfig, refs, reqNumber, reqString, type Refs } from "./common";
import { isServerCode } from "@fsm/shared";
import { enqueueDiscord } from "./discord";
import { tickerFor } from "./marketEvents";

const alertRef = (R: Refs, id: string) => R.doc(`alerts/${id}`);

/** "Tell me when James drops below £50." Delivered in-app, and on Discord if asked. */
export const createAlert = gameCall(async (req) => {
  const { uid, R, data } = await gameCtx(req);
  const stockId = reqString(data, "stockId", 128);
  const price = reqNumber(data, "price");
  const discord = data.discord === true;
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const cfg = await readConfig(tx, R);
    const [playerSnap, stockSnap, mineSnap] = await Promise.all([
      tx.get(R.player(uid)),
      tx.get(R.stock(stockId)),
      tx.get(R.col("alerts").where("uid", "==", uid).where("status", "==", "active")),
    ]);
    if (!playerSnap.exists) throw new HttpsError("permission-denied", "You're not an approved player.");
    if (!(playerSnap.data() as Player).isActive) throw new HttpsError("permission-denied", "Your account is deactivated.");
    if (!stockSnap.exists) throw new HttpsError("not-found", "Stock not found.");
    const stock = stockSnap.data() as Stock;
    if (!stock.listed) throw new HttpsError("failed-precondition", "That stock is delisted.");
    const check = validateAlert(data.direction, price, stock.price);
    if (!check.ok) throw new HttpsError("invalid-argument", check.error);
    if (mineSnap.size >= cfg.maxActiveAlerts) {
      throw new HttpsError("resource-exhausted", `You can have up to ${cfg.maxActiveAlerts} active alerts. Cancel one first.`);
    }
    const ref = R.col("alerts").doc();
    const alert: PriceAlert = {
      id: ref.id,
      uid,
      stockId,
      stockName: stock.displayName,
      direction: data.direction as PriceAlert["direction"],
      price,
      discord,
      status: "active",
      createdAt: now,
    };
    tx.set(ref, alert);
    return alert;
  });
});

export const cancelAlert = gameCall(async (req) => {
  const { uid, R, data } = await gameCtx(req);
  const id = reqString(data, "alertId", 128);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(alertRef(R, id));
    const alert = snap.data() as PriceAlert | undefined;
    if (!alert || alert.uid !== uid) throw new HttpsError("not-found", "Alert not found.");
    if (alert.status === "active") tx.update(alertRef(R, id), { status: "cancelled" });
  });
  return { ok: true };
});

/** Mark some (or, with no ids, all) of your notifications read. */
export const markNotificationsRead = gameCall(async (req) => {
  const { uid, R, data } = await gameCtx(req);
  const ids = data.ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || !ids.every((i) => typeof i === "string" && i.length <= 128))) {
    throw new HttpsError("invalid-argument", "ids must be a list of notification ids.");
  }
  const snap = await R.col("notifications").where("uid", "==", uid).where("read", "==", false).limit(200).get();
  const wanted = ids ? new Set(ids as string[]) : null;
  const batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    if (wanted && !wanted.has(d.id)) continue;
    batch.update(d.ref, { read: true });
    n++;
  }
  if (n) await batch.commit();
  return { updated: n };
});

/**
 * Check alerts whenever a stock's price changes. Each alert fires once: the
 * per-alert transaction makes sure two quick trades can't both deliver it.
 */
export const checkPriceAlerts = onDocumentUpdated({ document: "servers/{serverId}/stocks/{id}", retry: false }, async (event) => {
  const before = event.data?.before.data() as Stock | undefined;
  const after = event.data?.after.data() as Stock | undefined;
  if (!before || !after || before.price === after.price) return;
  if (await inMaintenance()) return;
  const serverId = event.params.serverId;
  if (!isServerCode(serverId)) return;
  const R = refs(serverId);
  const snap = await R.col("alerts").where("stockId", "==", after.id).where("status", "==", "active").get();
  const due = snap.docs.map((d) => d.data() as PriceAlert).filter((a) => alertFires(a, after.price));
  for (const a of due) {
    try {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(alertRef(R, a.id));
        const alert = fresh.data() as PriceAlert | undefined;
        if (!alert || !alertFires(alert, after.price)) return;
        const now = Date.now();
        tx.update(alertRef(R, a.id), { status: "triggered", triggeredAt: now, triggeredPrice: after.price });
        const nRef = R.col("notifications").doc();
        const note: AppNotification = {
          id: nRef.id,
          uid: alert.uid,
          kind: "alert",
          title: `🔔 ${alert.stockName} is ${alert.direction} £${alert.price.toFixed(2)}`,
          body: `Your alert "${alertSummary(alert.stockName, alert.direction, alert.price)}" fired at £${after.price.toFixed(2)}.`,
          stockId: alert.stockId,
          createdAt: now,
          read: false,
        };
        tx.set(nRef, note);
        if (alert.discord) enqueueDiscord(tx, R, "high", "priceAlert", alertMessage(alert.uid, tickerFor(after), alert.direction, alert.price, after.price), now);
      });
    } catch (err) {
      logger.error("Price alert failed", { serverId, alertId: a.id, err });
    }
  }
});
