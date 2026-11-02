"use client";

import { useMemo } from "react";
import { collection, doc, limit, orderBy, query, where } from "firebase/firestore";
import { NET_WORTH_SERIES_WEEKS, mergeNetWorthPoints, type NetWorthHistory, type NetWorthSeries } from "@fsm/shared";
import { fb } from "./firebase";
import { useDoc, useQuery } from "./hooks";

/**
 * A player's net worth over time for the charts: the weekly close history for
 * older ranges, the per-change series for the last NET_WORTH_SERIES_WEEKS
 * weeks, and (when given) the live value as the final point. Subscribe only
 * where the chart is shown (Portfolio, the Player tab).
 */
export function useNetWorthPoints(uid: string | null, live: number | undefined): { t: number; v: number }[] {
  const db = fb().db;
  const history = useDoc<NetWorthHistory>(uid ? doc(db, "netWorthHistory", uid) : null, [uid]);
  const series = useQuery<NetWorthSeries>(
    uid ? query(collection(db, "netWorthSeries"), where("uid", "==", uid), orderBy("week", "desc"), limit(NET_WORTH_SERIES_WEEKS)) : null,
    [uid],
  );
  return useMemo(() => {
    const pts = mergeNetWorthPoints(history.data?.points ?? [], series.data);
    if (live !== undefined) pts.push({ t: Math.max(Date.now(), (pts.at(-1)?.t ?? 0) + 1), v: live });
    return pts;
  }, [history.data, series.data, live]);
}
