"use client";

import type { ReactNode } from "react";
import { GameProvider } from "./GameProvider";
import { useServer } from "./ServerProvider";
import { Shell } from "./Shell";

/**
 * Keyed by server id: switching server unmounts the whole game tree, so every
 * Firestore subscription is torn down and re-created for the new server and no
 * cached state from the old one can render under the new one.
 */
export function GameRoot({ children }: { children: ReactNode }) {
  const { serverId } = useServer();
  return (
    <GameProvider key={serverId ?? "none"} serverId={serverId}>
      <Shell>{children}</Shell>
    </GameProvider>
  );
}
