# Friend Stock Market — Architecture & Feature Reference

> **Audience:** future agents and developers iterating on this project.
> **Purpose:** an up-to-date map of what exists, how it is wired together, and
> where it diverges from the original design document. Read this before making
> changes — it is the single source of truth for the current layout, and it
> notes every feature that was added beyond the original spec.

---

## 1. What this is

A play-money social trading game for a small friend group (10–20 people). Every
player is simultaneously a **trader** and a **tradable stock** named after
themselves. Players trade each other's stock against a constant-product AMM;
**prices move only from trades** — never from a system judgement of news. A
single chronological feed mixes trades and posts so players invent the story
behind each price move themselves.

All currency is fictional. There are no real-money purchases.

The original concept and mechanics are specified in the design document that
seeded the project (constant-product AMM, weekly close, CEO bonus, leaderboard,
feed). This document describes what was actually built, which is a **superset**
of that design — see §9 for the delta.

---

## 2. Repository layout (monorepo, npm workspaces)

```
stock-game/
├── shared/      Pure TypeScript game logic + Firestore types. No I/O.
│               Imported by BOTH the server and the client so previews and
│               the real trades run identical maths. Published as @fsm/shared.
├── functions/   Firebase Cloud Functions v2. The ONLY writer of game data.
│               Bundled with esbuild (shared/ is inlined, nothing to publish).
├── web/         Next.js 16 static export for GitHub Pages. Reads Firestore
│               live; every mutation goes through a callable function.
├── firestore.rules        All client writes denied; reads gated by membership.
├── firestore.indexes.json Composite indexes for the feed/portfolio queries.
├── firebase.json          Firestore + functions config, emulator ports.
├── scripts/               ensure-test-secret.mjs (integration test setup).
├── .github/workflows/     Pages deploy + weekly-close cron.
└── docs/                  This file + operational guides.
```

**Trust boundary:** the browser can read game data but can never write it.
`cash`, `poolCash`, `poolShares`, `price` only ever change inside a Cloud
Function transaction using the Admin SDK (which bypasses security rules). This
is the single most important invariant in the codebase — never add a client
write path to game state.

---

## 3. `shared/` — pure game logic (`shared/src/`)

Every module here is side-effect free and unit-tested against the design doc.
`index.ts` re-exports all of it. Timestamps are epoch-milliseconds (numbers)
everywhere so the same types work on server, client and in stored reports.

| File | Responsibility |
|---|---|
| `amm.ts` | Constant-product AMM: `quoteBuy`, `quoteSell`, `targetPoolCash`, `listingPool`, `topUpPool`. |
| `economy.ts` | Money rules: `startingCash`, `listingPrice`, `netWorth`, `leaderboardScore`, `weeklyGrowth`, `ceoBonus`, `isIdleSince`, `roundMoney`, `median`/`mean`, epsilons. |
| `positions.ts` | `positionFromTrades` — average-cost unrealised P/L for a holding. |
| `shorts.ts` | Synthetic short quotes: `quoteOpenShort`, `quoteCloseShort`, exposure/capital/borrow-fee helpers. |
| `bankruptcy.ts` | `settleDebt` — liquidate holdings, pay creditors proportionally, flag bankrupt. |
| `report.ts` | `WeeklyReport` shape, `mechanicsExplainer`, `reportToMarkdown`. |
| `content.ts` | `SiteContent` (rules + changelog), defaults, `MAX_CONTENT_LENGTH`. |
| `photo.ts` | Avatar validation: `parsePhotoDataUrl`, `PHOTO_SIZE_PX`, `MAX_PHOTO_BYTES`. |
| `config.ts` | `DEFAULT_CONFIG`, `CONFIG_BOUNDS`, `mergeConfig`, `validateConfigPatch`. |
| `types.ts` | Every Firestore document shape (the data model). |

### 3.1 The AMM (`amm.ts`)

Each stock owns a pool with cash `C` and shares `S`:

```
price = C / S
k     = C × S          (invariant between trades)
```

**Buy** (`quoteBuy(pool, grossCash, feePct)`): the fee comes off the top, the
rest enters the pool.

```
fee       = grossCash × feePct
netToPool = grossCash − fee
C' = C + netToPool
S' = k / C'
shares_out = S − S'
```

**Sell** (`quoteSell(pool, shares, feePct)`): shares enter the pool, cash leaves,
fee is deducted from the payout.

```
S' = S + shares
C' = k / S'
grossCash = C − C'
netCash   = grossCash − grossCash × feePct
```

**Pool depth scales with wealth (§2.1 of the design).** A target pool is the
cash that makes a `targetTradeSize × avgNetWorth` buy move price by
`targetImpact`. Because a buy of `Δc` scales price by `(1 + Δc/C)²`:

```
Δc       = targetTradeSize × avgNetWorth
C_target = Δc / (√(1 + targetImpact) − 1)
```

- `listingPool` sizes a brand-new stock's pool to `C_target` at its listing price.
- `topUpPool` runs at weekly close: if a pool's cash is below target, it adds
  cash **and shares in the ratio that keeps price unchanged** (`ΔS = ΔC / price`).
  It never shrinks a pool.

### 3.2 Economy (`economy.ts`)

| Function | Formula / rule |
|---|---|
| `startingCash(joinWeek)` | `baseStartingCash + max(0, joinWeek−1) × weeklyAllowance` (newcomers catch up to founders' accumulated allowances). |
| `listingPrice(listedPrices, base)` | median of currently-listed prices, else `baseStockPrice` for the very first stocks. |
| `netWorth(cash, holdings, priceOf)` | `cash + Σ shares × spot price`. |
| `leaderboardScore(nw, startingCash, totalAllowances)` | `nw / (startingCash + totalAllowances)`. Everyone starts at 1.00. **CEO bonus is excluded from the denominator** but counts in net worth. |
| `weeklyGrowth(start, end, allowance)` | `(end − start − allowance) / start`. |
| `ceoBonus(sharesHeldByOthers, price, rate)` | `rate × sharesHeldByOthers × price`. |
| `isIdleSince(lastActiveAt, now, weeks)` | true when no activity for `idleThresholdWeeks`. |

Constants: `roundMoney` → 2dp; `SHARE_EPSILON = 1e-9`; `CASH_EPSILON = 1e-6`;
`NET_WORTH_HISTORY_MAX = 104` (≈ two years of weekly samples).

### 3.3 Short selling (`shorts.ts`)

Shorts are **synthetic** — nothing is borrowed from another player. The AMM is
the counterparty, so a short eats the same price impact and fees as a sell
followed by a buy.

- Opening = `quoteSell`: sell shares you don't own, receive cash now, price falls.
- Closing = `quoteCloseShort`: buy the shares back; price rises; the fee is added
  on top of the pool cash needed (`grossSpend = netToPool / (1 − feePct)`). Throws
  if the pool is too shallow to source the shares.
- `shortableCapital(cash, holdingsValue)` = `cash + holdingsValue`. Open-short
  paper gains are deliberately excluded so a short can't fund a bigger short.
- `shortBorrowFee(shares, price, feePct)` = `shares × price × feePct`, charged
  weekly at close.
- Realised P/L = `openProceeds − closeCost − borrowFeesPaid`.

### 3.4 Bankruptcy (`bankruptcy.ts`)

`settleDebt` liquidates all of a debtor's holdings back into their pools, adds
that to cash, then settles creditors. If the raised cash covers the debt the
debtor keeps the change (solvent). Otherwise everything is split among creditors
proportional to what they are owed, the shortfall is the creditors' loss, and
the debtor is marked bankrupt (deactivated, but their stock stays listed so
holders can still sell). Pure — the caller applies pool/wallet effects.

Currently only reached when a `closeShort` buy-back exceeds the owner's cash.

---

## 4. Data model (`shared/src/types.ts` → Firestore)

All documents live at the paths below. IDs and relationships:

| Collection | Doc id | Key fields |
|---|---|---|
| `config/global` | fixed | All of `GameConfig` (see §4.1). Readable by any signed-in user. |
| `content/global` | fixed | `SiteContent` { rules, changelog, updatedAt }. |
| `meta/state` | fixed | `GameState`: `currentWeek` (from 1), `prizePool`, `weekFees`, `weekStartedAt`, `lastCloseAt`. |
| `players/{uid}` | auth uid | `displayName`, `cash`, `joinWeek`, `isActive`, `isIdle`, `lastActiveAt`, `createdAt`, `startingCash`, `totalAllowances`, `totalBonus`, `netWorthWeekStart`, optional `lastPostAt`, optional `bankruptAt`. |
| `stocks/{uid}` | == ownerId | `price`, `poolCash`, `poolShares`, `k`, `listed`, `listPrice`, `listedAt`, `listedWeek`, `weekOpenPrice`/`weekHigh`/`weekLow`/`weekTradeCount`, optional `delistedAt`. |
| `holdings/{uid}_{stockId}` | composite | `uid`, `stockId`, `shares`, `updatedAt`. Flat (not nested) so "all holders of a stock" is one query. |
| `shorts/{id}` | auto | `ownerId/Name`, `stockId/Name`, `shares`, `status` (open/closed), `openPrice`, `openProceeds`, `openedAt`, `openWeek`, `borrowFeesPaid`, and on close `closePrice`/`closeCost`/`realisedPnl`/`closedAt`/`closeWeek`. |
| `trades/{id}` | auto | `traderId/Name`, `stockId/Name`, `side`, `cashAmount` (gross), `netCash` (wallet delta, negative for buys), `shares`, `fee`, `priceBefore/After`, `week`, `createdAt`, optional `linkedPostId`, optional `kind` (`openShort`/`closeShort`). |
| `posts/{id}` | auto | `authorId/Name` ("system"/"Market" for system posts), `taggedStockId/Name`, `text`, `linkedTradeId`, `linkedTradeSummary`, `reactions` (type→uid[]), `reactionCount`, `system`, `week`, `createdAt`. |
| `photos/{uid}` | auth uid | `dataUrl`, `updatedAt`. Separate from the stock doc so price ticks don't resend image bytes. |
| `netWorthHistory/{uid}` | auth uid | `points[]` of `{week, t, v}`, one appended per weekly close, capped to 104. |
| `weeklyReports/week-NNNN` | zero-padded week | Full `WeeklyReport` payload + rendered `markdown`. |
| `registrations/{uid}` | auth uid | `displayName`, `email`, `status` (pending/approved/rejected), `createdAt`, `decidedAt/By` (+ a `displayNameLower` for uniqueness). |
| `admins/{uid}` | auth uid | Existence = admin. Created manually in the console. |
| `auditLog/{id}` | auto | `actorId`, `action`, `targetId`, `details`, `createdAt`. |

Reaction types: `like 👍`, `laugh 😂`, `wow 😮`, `down 👎`. Reactions are purely
social and never affect price.

### 4.1 Configuration (`config/global`)

Every tunable, with its default (`DEFAULT_CONFIG`) and validation bounds
(`CONFIG_BOUNDS`). The admin Config editor is generated from `CONFIG_BOUNDS`;
`updateConfig` validates patches with `validateConfigPatch` (rejects unknown
keys, non-numbers, out-of-range, non-integers).

| Key | Default | Meaning |
|---|---|---|
| `baseStartingCash` | 1000 | Founder starting cash. |
| `baseStockPrice` | 50 | Listing price for the very first stocks. |
| `weeklyAllowance` | 200 | Flat weekly cash per active player. |
| `tradingFeePct` | 0.015 | Fee per trade (funds the prize pool). |
| `bonusRate` | 0.01 | CEO bonus rate on value held by others. |
| `targetTradeSize` | 0.1 | Trade size (fraction of avg net worth) used to size pools. |
| `targetImpact` | 0.05 | Price move a target trade should cause. |
| `idleThresholdWeeks` | 4 | Weeks of inactivity before idle. |
| `flagMovePct` | 0.5 | Report flag: weekly stock move above this. |
| `flagOwnershipPct` | 0.5 | Report flag: one holder owning more than this share. |
| `flagCollusionMinTrades` | 3 | Report flag: back-and-forth trades each way. |
| `minHoursBetweenAutoCloses` | 144 | Cron close is skipped inside this window (6 days). |
| `maxPostLength` | 500 | Max post characters. |
| `postCooldownSeconds` | 10 | Min seconds between a player's standalone posts (0 disables). |
| `maxShortExposurePct` | 0.5 | Max open-short value as a fraction of capital. |
| `shortBorrowFeePct` | 0.02 | Weekly borrow fee on each open short's value. |

---

## 5. `functions/` — Cloud Functions (`functions/src/`)

Firebase Functions v2, region `europe-west2`, `maxInstances: 5`. Every function
is `onCall` (callable, checks `request.auth`) except `weeklyCloseCron`, which is
an `onRequest` HTTPS endpoint guarded by a bearer secret.

`common.ts` holds the shared infrastructure: region/instance limits, Admin SDK
init, typed document `refs`, `readConfig`/`readState`/`readWorld`, auth helpers
(`requireAuth`, `isAdmin`, `requireAdmin`), argument validators, and audit-log
helpers.

**Deployed surface (`index.ts`):**

| Function | File | Access | What it does |
|---|---|---|---|
| `register` | approval.ts | signed-in | Request to join (name uniqueness check); writes a pending registration. No funds. |
| `approvePlayer` | approval.ts | admin | Atomically creates the Player (with catch-up `startingCash`), creates a listed Stock at `listingPrice`, sizes the pool via `listingPool` (avg net worth incl. the newcomer), posts a system listing message, audits. |
| `rejectPlayer` | approval.ts | admin | Marks a registration rejected. |
| `trade` | trading.ts | player | Buy (spend cash, fee off the top) or sell (shares). Updates wallet + holding, applies the pool, adds fee to prize pool + week fees, writes the Trade and an optional linked Post. |
| `openShort` / `closeShort` | shorts.ts | player | Open/close a synthetic short; enforces the exposure cap; fee → prize pool; close can trigger bankruptcy settlement. |
| `createPost` / `toggleReaction` / `deletePost` | social.ts | player / player / admin | Standalone/tagged/trade-linked posts (cooldown + length limits), toggle a reaction, admin moderation (keeps text in the audit log). |
| `touch` | adminOps.ts | player | Records activity once per session; silently reactivates idle players (no back-pay). |
| `updateConfig` | adminOps.ts | admin | Validates and merges a config patch; audits before/after. |
| `delistPlayer` | adminOps.ts | admin | Pays every holder out at the last price, unlists the stock, deactivates the account, system post, audit. |
| `runWeeklyClose` | adminOps.ts | admin | Manual close via `closeWeek` with an `expectedWeek` guard against double-clicks. |
| `weeklyCloseCron` | adminOps.ts | bearer secret | HTTPS endpoint for the GitHub Actions cron; POST only, `Authorization: Bearer <CRON_SECRET>` (timing-safe, ≥16 chars); self-skips inside `minHoursBetweenAutoCloses`. |
| `setStockPhoto` | photo.ts | player / admin | Set/remove your own avatar (validated); admins may only remove others'. |
| `renamePlayer` | rename.ts | admin | Renames player/stock/registration, then rewrites denormalised names across past trades/posts via a bulkWriter. |
| `updateContent` | content.ts | admin | Patches the Rules / Change log markdown on `content/global`. |
| `resetGame` | reset.ts | admin | Wipe-to-day-one (see §9 and the README). Not a single transaction. |

### 5.1 Weekly close ordering (`weeklyClose.ts`)

`closeWeek` runs as one Firestore transaction so balances are never half-updated
and trades can't interleave. Order (design §6):

0. **Guards** — `expectedWeek` match (manual) and cron skip inside the min window.
1. **Idle flagging** — mark players idle per `idleThresholdWeeks`.
2. **Snapshot** all balances.
3. **Weekly allowance** to active non-idle players.
4. **CEO bonus** = `bonusRate × shares held by others × price`.
5. **Short borrow fees** charged to each open short's owner into the prize pool.
6. **Pool top-up** to target depth at the new average net worth (price unchanged).
7. **Leaderboard + winner** = highest `weeklyGrowth` among non-idle players with a positive start-of-week net worth.
8. **Pay the entire prize pool** to the winner, reset to 0 (rolls over if no eligible winner).
9. **Build and store the WeeklyReport** (money, prices, health, activity, highlights, flags, markdown).
10. **Writes**: updated players (incl. next week's `netWorthWeekStart`), append a net-worth history point, **reactivate bankrupt players**, reset stock weekly stats, advance `meta/state` to `week + 1` (`prizePool = remaining + borrowFeesCollected`), update each short's `borrowFeesPaid`, post a "Week N closed" system message, audit.

Report flags (`computeFlags`): `bigMove` (weekly move beyond `flagMovePct`),
concentration (one holder beyond `flagOwnershipPct`, ignoring dust), and
collusion (two players trading each other beyond `flagCollusionMinTrades`).

---

## 6. `web/` — frontend (`web/src/`)

Next.js 16 App Router, React 19, static export for GitHub Pages. It reads
Firestore live and writes only through callable functions.

**`lib/`**
- `firebase.ts` — lazy client init from `NEXT_PUBLIC_*` env, optional emulator
  connect, `firebaseConfigured` flag; never initialises during the static
  prerender.
- `api.ts` — typed `httpsCallable` wrappers for every function + `errorMessage`.
- `hooks.ts` — `useDoc` / `useQuery` live `onSnapshot` subscriptions.
- `format.ts` — `gbp`, `pct`, `shares`, `ago`, `changeClass`, `stockHref`.

**Context & chrome**
- `components/GameProvider.tsx` — the data backbone. Tracks auth +
  registration/admin/player membership; when a member, live-subscribes to
  stocks, players, holdings, photos, the user's open shorts, state and config;
  derives `PlayerView` (net worth, holdings value, score); calls `api.touch()`
  once per session. `useGame()` exposes it all.
- `components/Shell.tsx` — gatekeeping: not configured → setup notice; signed
  out → `SignIn`; not approved → `Registration`; otherwise the nav + page.
  Nav: Feed, Market, Portfolio, Leaderboard, Reports (+ Admin). On phones it is
  a single horizontally-swipeable row.
- `components/AccountMenu.tsx` — avatar dropdown in the top bar (after
  easyui's origin-dropdown): name/email, cash, net worth, week, then My stock,
  Rules, Change log, a disabled "Preferences — coming soon" slot, and Sign out.
  This is where future account options should go. Full menu-button keyboard
  support (arrows, Home/End, Esc returns focus, Tab closes).

**Routes (`app/`)**
| Path | Screen |
|---|---|
| `/` | Feed: prize-pool pill, post composer, global chronological feed. |
| `/market` | Sortable table of listed stocks (price, week change, trades, your holdings), median price. |
| `/stock?id=` | Stock detail: avatar, price, week stats, pool depth, price chart, `TradePanel`, `ShortPanel`, `PhotoEditor` (own), holders, scoped feed. |
| `/portfolio` | Cash/holdings/net worth/score, net-worth chart, per-holding avg cost + unrealised P/L, open shorts (live P/L), CEO-bonus summary, recent trades. |
| `/leaderboard` | Ranked by score (idle greyed and unranked), live weekly-growth leader. |
| `/reports` + `/report?id=` | Weekly report list + single report (rendered markdown). |
| `/rules`, `/changelog` | Editable `content/global`, rendered with `SimpleMarkdown`. Reached from the account menu. |
| `/admin` | Approvals, Players (+rename), Weekly close, Config editor, Content editor, Delist, Audit log, Reset (type-RESET gate). |

**Components:** `Feed`, `TradePanel` (live AMM preview using the shared quote
functions), `ShortPanel`, `PostComposer`, `PhotoEditor` (client-side resize),
`Avatar`, `LineChart` / `PriceChart`, `SlidePagination`, `AccountMenu`,
`SimpleMarkdown`, `SignIn`, `Registration`.

**UI conventions.** No UI framework, no Tailwind, no animation library: all
styling is plain CSS in `app/globals.css` using the `--bg/--panel/--accent/--up/--down`
variables, and motion is CSS transitions or `requestAnimationFrame`. The
interactive pieces are hand-ported from [easyui](https://easyui.site/components)
(which uses Tailwind + framer-motion) rather than installed. Every animation
respects `prefers-reduced-motion`.

- **`LineChart`** (`components/LineChart.tsx`, maths in `lib/chart.ts`) — the
  interactive area chart used for price, net worth and per-holding value.
  Range pills (only those shorter than the data, plus All), a header showing
  the hovered value and % change over the range, scrub crosshair + tooltip
  (mouse, horizontal touch drag, or arrow keys), left-to-right reveal, and an
  interruptible morph when the range changes or a live trade arrives (every
  range is resampled to 160 points so shapes interpolate 1:1). `step` draws a
  step line; `baseline` draws a dashed reference (cost basis). The SVG is
  absolutely positioned inside a measured container so it never props a grid
  cell open on resize.
- **Feed pagination** (`components/Feed.tsx`, `SlidePagination.tsx`,
  `lib/pagination.ts`) — 15 items per page on the Feed, 10 on a stock page.
  Trades and posts are two newest-first Firestore queries merged on the
  client, so there's no cheap total count. Each query loads the current page
  plus one page of lookahead; only the merged prefix newer than the oldest
  item of any truncated query is treated as complete (`feedCutoff`), and the
  query holding that cutoff back is extended. Limits only grow, so paging back
  costs no extra reads. A trailing "…" means older pages exist that haven't
  been loaded yet.
- **`useSlideIndicator`** (`lib/hooks.ts`) — measures the active child and
  slides a highlight under it; shared by the chart range pills and the pager.

---

## 7. Security & Firestore rules

- `firestore.rules`: **all client writes denied** (`if false`). Reads are gated
  by membership helpers — `signedIn`, `isAdmin` (an `admins/{uid}` doc exists),
  `isPlayer` (a `players/{uid}` doc exists), `member` (player or admin). Members
  read game collections; any signed-in user reads `config`/`content`; a player
  reads their own `players` doc and `registrations`; `admins/{uid}` is readable
  only by that uid; `auditLog` is admin-only; everything else is denied.
- `firestore.indexes.json`: composite indexes for `trades(stockId+createdAt)`,
  `trades(traderId+createdAt)`, `posts(taggedStockId+createdAt)`,
  `registrations(status+createdAt)`, `shorts(ownerId+status)`.
- `weeklyCloseCron` is the only public endpoint; it is protected by a bearer
  secret with a timing-safe comparison.

---

## 8. Infrastructure, build & tests

- **`firebase.json`** — Firestore rules/indexes; functions source `functions`,
  Node 22, predeploy `npm run build`; emulator ports: auth 9099, functions 5001,
  firestore 8180, UI on.
- **`functions/build.mjs`** — esbuild bundles `src/index.ts` and the `@fsm/shared`
  workspace into a single CJS `lib/index.js`, externalising firebase-admin /
  firebase-functions. `shared/` never needs publishing.
- **GitHub Actions**
  - `deploy-pages.yml` (push to `main` / PR / dispatch): a `test` job (Node 22 +
    Java 21 for the Firestore emulator) runs typecheck + unit + integration; a
    `build` job does the Next static export with `NEXT_PUBLIC_BASE_PATH=/<repo>`
    + Firebase vars and adds `.nojekyll`; a `deploy` job publishes to Pages.
  - `weekly-close.yml` (cron `0 20 * * 0`, Sun 20:00 UTC, + dispatch): curls
    `WEEKLY_CLOSE_URL` with `Bearer CRON_SECRET`.
- **Root scripts:** `build`, `typecheck`, `test` / `test:unit`
  (`vitest.unit.config.mts`) / `test:integration` (ensure-test-secret → build
  functions → `firebase emulators:exec --project demo-fsm`
  `vitest.integration.config.mts`), `dev:web`, `emulators`, `deploy:backend`.
- **Tests**
  - **Unit** (`shared/test/`): AMM maths vs the design doc, pool sizing/top-up,
    starting cash, median listing, scoring, weekly growth, CEO bonus, idle rule,
    config validation, shorts, bankruptcy, positions, report markdown.
  - **Integration** (`functions/test/`): calls the real functions in the
    emulators as signed-in users — onboarding/approval, security rules, trading
    & fees, posts/reactions/moderation, shorts + borrow fees, weekly close + cron
    auth, admin ops, photos, reset. Always uses the `demo-fsm` project on
    `127.0.0.1` and wipes the emulator before each test.

Local dev needs **Node 22+** and **Java 21+** (for the Firestore emulator). See
the README for the full setup, deploy steps and the list of required GitHub
variables/secrets.

---

## 9. Divergence from the original design document

The build implements the original design faithfully and then extends it. When
reasoning about the project, treat the items below as **in scope and shipped**,
not as ideas.

### 9.1 Faithful to the design
Constant-product AMM and all its formulas; fee → prize pool; pool depth scaling
and weekly top-up (§2.1); starting-cash catch-up (§4.1); median listing price
(§4.2); admin approval flow (§4.3); idle handling and the relative-growth
leaderboard (§5); weekly close ordering and the stored weekly report (§6);
chronological feed with trade-linked posts and social reactions (§7); the
Next.js + Firebase + Cloud Functions + GitHub Pages/Actions stack (§8); and the
full configurable-parameter set (§9).

### 9.2 Added beyond the design
| Feature | Where | Notes |
|---|---|---|
| **Short selling** | `shared/shorts.ts`, `functions/shorts.ts`, `ShortPanel` | Synthetic shorts against the AMM, capped at `maxShortExposurePct` of capital, weekly `shortBorrowFeePct` into the prize pool. Labelled SHORT/COVER in the feed. |
| **Bankruptcy settlement** | `shared/bankruptcy.ts`, `functions/bankruptcy.ts` | Liquidate holdings → pay creditors pro-rata → deactivate if short. Currently only reachable from an unaffordable `closeShort`. Bankrupt players reactivate at the next close. |
| **Stock photos / avatars** | `shared/photo.ts`, `functions/photo.ts`, `PhotoEditor` | 256px data-URL avatars with server-side magic-byte validation, stored in `photos/{uid}` so price ticks don't resend bytes. |
| **Admin rename** | `functions/rename.ts` | Renames a player and rewrites denormalised names across all past trades/posts. |
| **Full reset** | `functions/reset.ts` | Wipe-to-day-one preserving accounts/admins/config/audit; re-queues players as pending. |
| **Net-worth history + charts** | `netWorthHistory/{uid}`, `LineChart`, `PriceChart` | Weekly per-player samples (capped 104) powering the Portfolio and stock charts. |
| **Editable Rules & Change log** | `shared/content.ts`, `functions/content.ts`, `/rules`, `/changelog` | Admin-editable `content/global`, rendered with `SimpleMarkdown`. |
| **Audit log** | `auditLog/{id}`, Admin page | Every admin action records actor/target/details. |
| **Post cooldown / spam guard** | `functions/social.ts`, `postCooldownSeconds` | Minimum seconds between a player's standalone posts. |
| **Double-close protection** | `adminOps.ts` | Manual close carries the week number; cron enforces `minHoursBetweenAutoCloses`. |

### 9.3 Deliberate deviations to be aware of
- **Worked example mismatch:** the design doc's "Buy £500 → £64.00 (+28%)" row
  is wrong for its own formula; the code follows the formula and yields
  **£63.28 (+26.6%)**. The £100-buy and 10-share-sell rows match. Treat the
  formula (and the `amm.test.ts` expectations) as authoritative, not the doc's
  rounded table.
- **Reports/content are stored, admin-editable documents**, not regenerated
  from static text — the mechanics explainer in a report is rendered from the
  live config so each report is self-contained.

---

## 10. Guidance for future changes

- **Never let the client write game state.** New mutations must be Cloud
  Functions; keep `firestore.rules` write rules at `if false`.
- **Put maths in `shared/`.** If the client needs a preview (it almost always
  does), the formula belongs in `shared/` so server and client agree.
- **Everything that spends or earns money runs inside a transaction** and reads
  config/state first. Follow the patterns in `trading.ts` and `weeklyClose.ts`.
- **New config belongs in three places:** `GameConfig` (`types.ts`),
  `DEFAULT_CONFIG` + `CONFIG_BOUNDS` (`config.ts`). The admin editor and
  validation pick it up automatically.
- **Add a unit test in `shared/test/` for any new formula** and an integration
  test in `functions/test/` for any new function; CI blocks deploys on failure.
- **Denormalised names** (`traderName`, `stockName`, `authorName`,
  `taggedName`) must be kept in sync — see `rename.ts` for the pattern.
- Keep the friend-group scale in mind: `readWorld` loads every player/stock/
  holding, which is fine for tens of documents but is not built for thousands.
