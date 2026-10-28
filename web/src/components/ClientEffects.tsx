"use client";

import { useEffect } from "react";
import { applyTheme, getPrefs, watchSystemTheme } from "@/lib/prefs";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/** App-wide browser side effects: keep the theme in sync and register the PWA service worker. */
export function ClientEffects() {
  useEffect(() => {
    applyTheme(getPrefs().theme);
    return watchSystemTheme();
  }, []);

  useEffect(() => {
    // Only in production builds: a caching worker in `next dev` serves stale bundles.
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`${BASE_PATH}/sw.js`, { scope: `${BASE_PATH}/` }).catch(() => undefined);
  }, []);

  return null;
}
