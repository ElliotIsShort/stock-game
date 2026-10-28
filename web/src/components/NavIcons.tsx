/** 24px stroke icons for the mobile tab bar. Decorative: each tab has a text label. */
const PATHS: Record<string, string[]> = {
  feed: ["M4 5h16v11H8l-4 4z", "M8 9h8", "M8 12h5"],
  market: ["M4 20V4", "M4 20h16", "M8 16v-5", "M12 16V8", "M16 16v-3", "M20 16V6"],
  portfolio: ["M4 8h16v11H4z", "M9 8V5h6v3", "M4 13h16"],
  leaderboard: ["M8 4h8v5a4 4 0 0 1-8 0z", "M8 6H5a3 3 0 0 0 3 4", "M16 6h3a3 3 0 0 1-3 4", "M12 13v4", "M8 20h8"],
  reports: ["M6 3h9l4 4v14H6z", "M14 3v5h5", "M9 13h7", "M9 17h5"],
  admin: ["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z", "M9 12l2 2 4-4"],
};

export function NavIcon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(PATHS[name] ?? []).map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
