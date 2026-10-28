// Regenerates the PWA / home-screen icons in web/public/icons and web/src/app/apple-icon.png.
// Uses sharp, which Next.js installs: `node scripts/generate-icons.mjs`.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const sharp = require("sharp");

const BG = "#0e1116";
const UP = "#3fb950";

/** The trend-line mark from app/icon.svg, scaled into a square with `pad` (fraction) on each side. */
function svg(size, { pad, radius }) {
  const inner = size * (1 - 2 * pad);
  const s = inner / 32;
  const o = size * pad;
  const pt = (x, y) => `${(o + x * s).toFixed(1)},${(o + y * s).toFixed(1)}`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * radius}" fill="${BG}"/>
  <g fill="none" stroke="${UP}" stroke-width="${3 * s}" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="${pt(4, 24)} ${pt(12, 16)} ${pt(18, 20)} ${pt(28, 7)}"/>
    <polyline points="${pt(22, 7)} ${pt(28, 7)} ${pt(28, 13)}"/>
  </g>
</svg>`);
}

const out = new URL("../web/public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });

const jobs = [
  // "any" icons keep a small margin and rounded corners.
  ["icon-192.png", 192, { pad: 0.08, radius: 0.19 }],
  ["icon-512.png", 512, { pad: 0.08, radius: 0.19 }],
  // Maskable: full-bleed square, artwork inside the 80% safe zone (Android crops it to a shape).
  ["maskable-512.png", 512, { pad: 0.2, radius: 0 }],
];
for (const [name, size, opts] of jobs) {
  await sharp(svg(size, opts)).png().toFile(fileURLToPath(new URL(name, out)));
}
// iOS applies its own rounded mask, so the Apple icon is square too.
await sharp(svg(180, { pad: 0.14, radius: 0 })).png().toFile(fileURLToPath(new URL("../web/src/app/apple-icon.png", import.meta.url)));
console.log("Icons written.");
