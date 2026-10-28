"use client";

import { prefersReducedMotion } from "./hooks";

const COLOURS = ["#3fb950", "#58a6ff", "#d29922", "#bc8cff", "#f778ba", "#39c5cf"];

/**
 * A short burst of confetti on a throwaway full-screen canvas (no library).
 * Does nothing under prefers-reduced-motion; the banner/modal carries the news.
 */
export function fireConfetti(durationMs = 2600): void {
  if (typeof window === "undefined" || prefersReducedMotion()) return;
  const canvas = document.createElement("canvas");
  canvas.className = "confetti";
  canvas.setAttribute("aria-hidden", "true");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  const count = Math.min(180, Math.round(w / 6));
  const pieces = Array.from({ length: count }, (_, i) => {
    // Two cannons from the bottom corners, aimed up and inwards.
    const left = i % 2 === 0;
    const angle = (left ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.7;
    const speed = 9 + Math.random() * 9;
    return {
      x: left ? 0 : w,
      y: h,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 1.4,
      size: 6 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.4,
      colour: COLOURS[i % COLOURS.length],
    };
  });

  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = t > durationMs - 600 ? Math.max(0, (durationMs - t) / 600) : 1;
    for (const p of pieces) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.colour;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
