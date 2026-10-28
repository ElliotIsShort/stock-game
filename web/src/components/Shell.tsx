"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useGame } from "./GameProvider";
import { SignIn } from "./SignIn";
import { RegistrationGate } from "./Registration";
import { AccountMenu } from "./AccountMenu";
import { AnimatedNumber } from "./AnimatedNumber";
import { MarketStrip } from "./MarketStrip";
import { Moments } from "./Moments";
import { NotificationBell } from "./NotificationBell";
import { RecapCard } from "./RecapCard";
import { NavIcon } from "./NavIcons";

const NAV = [
  { href: "/", label: "Feed", short: "Feed", icon: "feed" },
  { href: "/market/", label: "Market", short: "Market", icon: "market" },
  { href: "/portfolio/", label: "Portfolio", short: "Portfolio", icon: "portfolio" },
  { href: "/leaderboard/", label: "Leaderboard", short: "Leaders", icon: "leaderboard" },
  { href: "/reports/", label: "Reports", short: "Reports", icon: "reports" },
];
const ADMIN_NAV = { href: "/admin/", label: "Admin", short: "Admin", icon: "admin" };
// Rules and the Dev diary live in the account menu to keep the nav short on phones.
// On phones the top nav is replaced by a bottom tab bar (CSS switches between them).

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

  const previewBanner = g.previewingAsPlayer && (
    <div className="banner preview-banner" role="status">
      <span>Viewing as a player: admin tools are hidden.</span>
      <button type="button" className="link" onClick={() => g.setPreviewAsPlayer(false)}>Exit player view</button>
    </div>
  );

  if (!g.isMember) {
    return (
      <>
        {previewBanner}
        <main className="page"><RegistrationGate /></main>
      </>
    );
  }

  const nav = g.isAdmin ? [...NAV, ADMIN_NAV] : NAV;
  const me = g.me ? g.playerById.get(g.me.uid) : undefined;
  const current = (href: string) => (path === href || path === href.replace(/\/$/, "") ? "page" : undefined);

  return (
    <>
      <div className="chrome">
        <header className="topbar">
          <Link href="/" className="brand" aria-label="Stonker">
            <span aria-hidden="true">📈</span>
            <span>Stonker</span>
          </Link>
          <nav aria-label="Main" className="topnav">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} aria-current={current(n.href)}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="me">
            {me && (
              <span title="Cash / net worth">
                <AnimatedNumber value={me.cash} /> <span className="muted">/ <AnimatedNumber value={me.netWorth} /></span>
              </span>
            )}
            {g.state && <span className="muted me-week">Week {g.state.currentWeek}</span>}
            {g.me && <NotificationBell />}
            <AccountMenu />
          </div>
        </header>
        <MarketStrip />
      </div>
      {previewBanner}
      {g.me && !g.me.isActive && <div className="banner">Your stock has been delisted. You can browse but not trade.</div>}
      <main className="page">
        {g.recap && <RecapCard />}
        {children}
      </main>
      <Moments />
      <nav aria-label="Main" className="tabbar">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} aria-current={current(n.href)}>
            <NavIcon name={n.icon} />
            <span>{n.short}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
