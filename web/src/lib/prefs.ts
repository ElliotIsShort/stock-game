"use client";

import { useSyncExternalStore } from "react";

/**
 * Per-device preferences, kept in localStorage (they're cosmetic, so they
 * never touch Firestore). The theme is applied to <html data-theme> before
 * first paint by THEME_BOOT_SCRIPT in the root layout.
 */
export type ThemePref = "system" | "dark" | "light";
export interface Prefs {
  theme: ThemePref;
  /** Off by default. */
  sound: boolean;
}

const KEY = "fsm:prefs";
const DEFAULTS: Prefs = { theme: "system", sound: false };
/** Matches the --bg of each theme in globals.css, for the browser/PWA chrome colour. */
const THEME_COLOR = { dark: "#0e1116", light: "#f6f8fa" } as const;

function read(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return {
      theme: raw.theme === "dark" || raw.theme === "light" ? raw.theme : "system",
      sound: raw.sound === true,
    };
  } catch {
    return DEFAULTS;
  }
}

let current: Prefs = DEFAULTS;
let loaded = false;
const listeners = new Set<() => void>();

function snapshot(): Prefs {
  if (!loaded && typeof window !== "undefined") {
    current = read();
    loaded = true;
  }
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // Another tab changed them.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = read();
    applyTheme(current.theme);
    fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function getPrefs(): Prefs {
  return snapshot();
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...snapshot(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode / storage full: keep the in-memory value for this session.
  }
  if (patch.theme) applyTheme(current.theme);
  for (const fn of listeners) fn();
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULTS);
}

export function resolveTheme(pref: ThemePref): "dark" | "light" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(pref: ThemePref): void {
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/** Follow the OS setting while the preference is "system". Call once on mount. */
export function watchSystemTheme(): () => void {
  const mql = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (snapshot().theme === "system") applyTheme("system");
  };
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * Inlined in <head> so the saved theme applies before first paint (no flash
 * of the dark theme for light-mode users). Keep in sync with read()/applyTheme().
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})||"{}").theme;var t=p==="dark"||p==="light"?p:(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="light"?${JSON.stringify(THEME_COLOR.light)}:${JSON.stringify(THEME_COLOR.dark)});}catch(e){}})();`;
