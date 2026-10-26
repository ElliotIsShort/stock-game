"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { gbp, stockHref } from "@/lib/format";
import { Avatar } from "./Avatar";
import { useGame } from "./GameProvider";

/**
 * Account dropdown in the top bar (after easyui's origin-dropdown): the menu
 * grows out of the trigger's corner with a slight scale + inward slide.
 * Keyboard: Enter/Space/↓ opens, ↑/↓/Home/End move, Esc closes and returns
 * focus to the trigger, Tab closes.
 *
 * New account options (e.g. preferences) go in the item list below.
 */
export function AccountMenu() {
  const g = useGame();
  const path = usePathname();
  const router = useRouter();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const me = g.me ? g.playerById.get(g.me.uid) : undefined;
  const name = me?.displayName ?? g.user?.displayName ?? g.user?.email ?? "Account";
  const uid = me?.uid ?? g.user?.uid ?? "";

  // Close on navigation.
  useEffect(() => setOpen(false), [path]);

  // Close on outside press.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
  const focusItem = (which: "first" | "last") => {
    // Wait a frame so the menu is visible (and focusable) before moving focus.
    requestAnimationFrame(() => {
      const list = items();
      (which === "first" ? list[0] : list[list.length - 1])?.focus();
    });
  };

  function togglePreview() {
    const next = !g.previewingAsPlayer;
    g.setPreviewAsPlayer(next);
    setOpen(false);
    // The admin page is empty for players, so leave it when switching to the player view.
    if (next && path.startsWith("/admin")) router.push("/");
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      focusItem(e.key === "ArrowDown" ? "first" : "last");
    }
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1]?.focus();
    }
  }

  return (
    <div className="account" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) focusItem("first");
        }}
        onKeyDown={onTriggerKey}
      >
        <Avatar uid={uid} name={name} size={28} />
        <span className="account-name">{name}</span>
        <svg className="account-chevron" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="sr-only">Account menu</span>
      </button>

      <div id={menuId} ref={menuRef} className="account-menu" role="menu" aria-label="Account" data-open={open || undefined} onKeyDown={onMenuKey}>
        <div className="account-head" role="presentation">
          <Avatar uid={uid} name={name} size={40} />
          <div>
            <strong>{name}</strong>
            {g.user?.email && <div className="muted small account-email">{g.user.email}</div>}
          </div>
        </div>
        {(me || g.state) && (
          <dl className="account-facts small" role="presentation">
            {me && (
              <>
                <dt>Cash</dt>
                <dd>{gbp(me.cash)}</dd>
                <dt>Net worth</dt>
                <dd>{gbp(me.netWorth)}</dd>
              </>
            )}
            {g.state && (
              <>
                <dt>Week</dt>
                <dd>{g.state.currentWeek}</dd>
              </>
            )}
          </dl>
        )}

        <div className="account-sep" role="separator" />
        {me && (
          <MenuLink href={stockHref(me.uid)} onSelect={() => setOpen(false)} hint="Price, holders and your photo">
            My stock
          </MenuLink>
        )}
        {g.isRealAdmin && (
          <button type="button" role="menuitem" className="account-item" onClick={togglePreview}>
            <span>{g.previewingAsPlayer ? "Exit player view" : "View as player"}</span>
            <span className="muted small">{g.previewingAsPlayer ? "Show admin tools again" : "Hide admin tools to see what players see"}</span>
          </button>
        )}
        <MenuLink href="/rules/" onSelect={() => setOpen(false)}>Rules</MenuLink>
        <MenuLink href="/changelog/" onSelect={() => setOpen(false)}>Change log</MenuLink>
        <div role="menuitem" aria-disabled="true" className="account-item disabled">
          <span>Preferences</span>
          <span className="muted small">Coming soon</span>
        </div>

        <div className="account-sep" role="separator" />
        <button
          type="button"
          role="menuitem"
          className="account-item danger"
          onClick={() => {
            setOpen(false);
            void g.signOut();
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function MenuLink({ href, hint, onSelect, children }: { href: string; hint?: string; onSelect: () => void; children: ReactNode }) {
  return (
    <Link href={href} role="menuitem" className="account-item" onClick={onSelect}>
      <span>{children}</span>
      {hint && <span className="muted small">{hint}</span>}
    </Link>
  );
}
