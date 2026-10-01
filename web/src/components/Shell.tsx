"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { gbp } from "@/lib/format";
import { useGame } from "./GameProvider";
import { SignIn } from "./SignIn";
import { RegistrationGate } from "./Registration";

const NAV = [
  { href: "/", label: "Feed" },
  { href: "/market/", label: "Market" },
  { href: "/portfolio/", label: "Portfolio" },
  { href: "/leaderboard/", label: "Leaderboard" },
  { href: "/reports/", label: "Reports" },
];

/** App chrome + gatekeeping: signed out → sign in; not approved → registration; else the page. */
export function Shell({ children }: { children: ReactNode }) {
  const g = useGame();
  const path = usePathname();

  if (!g.configured) {
    return (
      <main className="page">
        <div className="card narrow">
          <h1>Setup needed</h1>
          <p>Firebase isn&apos;t configured. Copy <code>web/.env.example</code> to <code>web/.env.local</code> and fill it in.</p>
        </div>
      </main>
    );
  }
  if (g.authLoading || (g.user && g.loadingMembership)) {
    return <main className="page"><p className="muted" aria-live="polite">Loading…</p></main>;
  }
  if (!g.user) return <main className="page"><SignIn /></main>;
  if (!g.isMember) return <main className="page"><RegistrationGate /></main>;

  const nav = g.isAdmin ? [...NAV, { href: "/admin/", label: "Admin" }] : NAV;
  const me = g.me ? g.playerById.get(g.me.uid) : undefined;

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">📈 Friend Stock Market</Link>
        <nav aria-label="Main">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href || path === n.href.replace(/\/$/, "") ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="me">
          {me && (
            <span title="Cash / net worth">
              {gbp(me.cash)} <span className="muted">/ {gbp(me.netWorth)}</span>
            </span>
          )}
          {g.state && <span className="muted">Week {g.state.currentWeek}</span>}
          <button type="button" className="link" onClick={g.signOut}>Sign out</button>
        </div>
      </header>
      {g.me && !g.me.isActive && <div className="banner">Your stock has been delisted. You can browse but not trade.</div>}
      <main className="page">{children}</main>
    </>
  );
}
