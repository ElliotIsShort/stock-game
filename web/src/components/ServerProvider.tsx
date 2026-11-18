"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc } from "firebase/firestore";
import { useState } from "react";
import { isServerCode, resolveServer, serverUiVisible, withServer, type Landing, type Registration, type UserDoc } from "@fsm/shared";
import { fb, firebaseConfigured } from "@/lib/firebase";
import { useDoc } from "@/lib/hooks";
import { rememberServer, recallServer } from "@/lib/serverStore";

/**
 * Who is signed in and WHICH game (server) they're looking at.
 *
 * The server comes from `?s=<code>`, then the last one used on this device,
 * then the user's only membership (see `resolveServer`). Players with a single
 * membership never see a server anywhere: `serverParam` is null for them, so no
 * link carries `?s=`, and a stray `?s=` for a server they're not in is ignored.
 * Only people in two or more servers (and the admin, when targeting a server
 * that isn't their only one) get `?s=` in their URLs.
 *
 * Membership is defined by `servers/{id}/players/{uid}`; `users/{uid}.serverIds`
 * is only the lookup cache read here. Rules and functions are the real boundary.
 */
export interface ServerContextValue {
  configured: boolean;
  authLoading: boolean;
  user: User | null;
  signOut: () => Promise<void>;
  registration: Registration | null;
  /** Has an admins/{uid} doc, regardless of "view as player". */
  isRealAdmin: boolean;
  /** `users/{uid}.serverIds` (valid codes only). */
  memberships: string[];
  /** Two or more memberships: the only people who may see anything server-related. */
  showServerUi: boolean;
  landing: Landing;
  /** The resolved server, or null (picker / not a member of anything). */
  serverId: string | null;
  /** What goes in `?s=` for this user right now, or null to omit it. */
  serverParam: string | null;
  /** Registration, admin and membership docs are still loading. */
  loading: boolean;
  /** Switch to another server, keeping the current page. */
  switchServer: (id: string) => void;
}

export const ServerContext = createContext<ServerContextValue | null>(null);

export function useServer(): ServerContextValue {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error("useServer must be used inside ServerProvider");
  return ctx;
}

export function ServerProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(firebaseConfigured);
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (!firebaseConfigured) return;
    return onAuthStateChanged(fb().auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
  }, []);

  const uid = user?.uid ?? null;
  // Never initialise Firebase during the static build's prerender.
  const db = firebaseConfigured && typeof window !== "undefined" ? fb().db : null;
  const registration = useDoc<Registration>(db && uid ? doc(db, "registrations", uid) : null, [uid]);
  const adminDoc = useDoc<object>(db && uid ? doc(db, "admins", uid) : null, [uid]);
  const userDoc = useDoc<UserDoc>(db && uid ? doc(db, "users", uid) : null, [uid]);

  const isRealAdmin = Boolean(adminDoc.data);
  const memberships = useMemo(() => (userDoc.data?.serverIds ?? []).filter(isServerCode), [userDoc.data]);
  const showServerUi = serverUiVisible(memberships);
  const loading = registration.loading || adminDoc.loading || userDoc.loading;

  const requested = params.get("s");
  // Read synchronously (not in an effect) so a returning multi-server user never sees the picker flash before their last server.
  // `chosen` is a choice made in this tab, which wins until the next reload.
  const [chosen, setChosen] = useState<string | null>(null);
  const lastUsed = chosen ?? (uid ? recallServer(uid) : null);

  const landing = useMemo(
    () => resolveServer({ requested, lastUsed, memberships, isAdmin: isRealAdmin }),
    [requested, lastUsed, memberships, isRealAdmin],
  );
  const serverId = landing.kind === "server" ? landing.serverId : null;

  // The only server a single-membership user can be in: it never needs saying.
  const silent = memberships.length === 1 ? memberships[0] : null;
  const serverParam = serverId && (showServerUi || serverId !== silent) ? serverId : null;

  // Remember the choice on this device (only meaningful with several memberships).
  useEffect(() => {
    if (uid && serverId && showServerUi && memberships.includes(serverId)) rememberServer(uid, serverId);
  }, [uid, serverId, showServerUi, memberships]);

  const switchServer = useCallback(
    (id: string) => {
      if (!isServerCode(id)) return;
      if (uid) rememberServer(uid, id);
      setChosen(id);
      router.push(withServer(path || "/", id));
    },
    [uid, router, path],
  );

  const value = useMemo<ServerContextValue>(
    () => ({
      configured: firebaseConfigured,
      authLoading,
      user,
      signOut: () => signOut(fb().auth),
      registration: registration.data,
      isRealAdmin,
      memberships,
      showServerUi,
      landing,
      serverId,
      serverParam,
      loading,
      switchServer,
    }),
    [authLoading, user, registration.data, isRealAdmin, memberships, showServerUi, landing, serverId, serverParam, loading, switchServer],
  );
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}
