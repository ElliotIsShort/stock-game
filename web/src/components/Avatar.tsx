"use client";

import { useGame } from "./GameProvider";

/** A stock's photo, or their initials if they haven't set one. Decorative: the name is always shown alongside. */
export function Avatar({ uid, name, size = 28 }: { uid: string; name: string; size?: number }) {
  const { photoOf } = useGame();
  const src = photoOf(uid);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) };
  if (src) {
    return <img className="avatar" src={src} alt="" style={style} />;
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span className="avatar placeholder" style={style} aria-hidden="true">
      {initials || "?"}
    </span>
  );
}
