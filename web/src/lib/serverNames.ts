"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import type { ServerDoc } from "@fsm/shared";
import { fb, firebaseConfigured } from "./firebase";

/**
 * Server docs for a handful of ids (the user's memberships), read once each.
 * A list query on `servers` would be refused by the rules (they depend on the
 * individual document), so each is fetched by id. Only people with two or more
 * memberships, and the admin, ever call this.
 */
export function useServerDocs(ids: readonly string[]): { docs: Map<string, ServerDoc>; loading: boolean } {
  const key = useMemo(() => [...ids].sort().join(","), [ids]);
  const [state, setState] = useState<{ docs: Map<string, ServerDoc>; loading: boolean }>({ docs: new Map(), loading: ids.length > 0 });
  useEffect(() => {
    if (!firebaseConfigured || typeof window === "undefined" || key === "") {
      setState({ docs: new Map(), loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const { db } = fb();
    Promise.all(
      key.split(",").map(async (id) => {
        try {
          const snap = await getDoc(doc(db, "servers", id));
          return snap.exists() ? ([id, snap.data() as ServerDoc] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (!cancelled) setState({ docs: new Map(rows.filter((r): r is readonly [string, ServerDoc] => r !== null)), loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state;
}
