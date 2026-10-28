# Friend Stock Market

Every member of a friend group is a tradable stock. Players trade each other with play money against a constant-product AMM; prices move only from trades. A chronological feed mixes trades and posts so players can spin the story behind each move.

## Layout

| Path | What |
|---|---| 
| `shared/` | Pure game logic used by both sides: AMM (`amm.ts`), economy formulas (`economy.ts`), config defaults + validation (`config.ts`), Firestore types, weekly-report markdown |
| `functions/` | Firebase Cloud Functions. Every balance change (register/approve, trade, posts, reactions, weekly close, delist, config) runs here. Bundled with esbuild so `shared/` is inlined |
| `web/` | Next.js static export for GitHub Pages. Reads Firestore live; writes only through callable functions |
| `firestore.rules` | Clients can read game data but never write anything. Only the Admin SDK (functions) writes |
| `.github/workflows/` | Pages deploy on push to `main`, and a weekly cron that pings the close endpoint |

### Firestore collections

`players/{uid}`, `stocks/{uid}`, `holdings/{uid}_{stockId}`, `trades/{id}`, `posts/{id}`, `photos/{uid}`, `registrations/{uid}`, `weeklyReports/week-NNNN`, `config/global`, `meta/state` (current week, prize pool), `admins/{uid}`, `auditLog/{id}`, `alerts/{id}` and `notifications/{id}` (private to their owner), `discordOutbox/{id}` and `discordState/rate` (server-only).

Stock photos live in `photos/{uid}` as small (256 px, ≤200 KB) JPEG data URLs rather than in Cloud Storage, so there's no extra service to enable. They're kept out of `stocks/{uid}` so live price updates don't resend image data.

Holdings are stored flat as `holdings/{uid}_{stockId}` (with `uid`/`stockId` fields) rather than nested, so "all holders of a stock" is a single query.

## Local development

Needs Node 22+ and Java 21+ (for the Firestore emulator). On macOS: `brew install openjdk@21`, then add `export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"` to `~/.zshrc`.

```sh
npm install
cp web/.env.example web/.env.local      # set NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-fsm, NEXT_PUBLIC_USE_EMULATORS=true
echo 'CRON_SECRET=any-local-secret-16+' > functions/.secret.local
npm run emulators                        # auth, firestore (8180), functions on the demo-fsm project
npm run dev:web                          # in another terminal
```

To make yourself admin, sign up in the app, then in the Emulator UI (http://127.0.0.1:4000/firestore) create an empty document `admins/<your uid>`. Admins who also want to play register like anyone else and approve themselves.

If the Firebase CLI fails with "self-signed certificate in certificate chain" (corporate networks that inspect HTTPS), prefix commands with `NODE_OPTIONS=--use-system-ca`.

## Testing

```sh
npm test                  # everything: unit + integration
npm run test:unit         # pure game logic, ~1s, no Firebase needed
npm run test:integration  # starts the emulators, runs the suite, shuts them down
```

- **Unit** (`shared/test/`): AMM maths against the design doc's worked example, pool sizing and top-ups, starting cash, median listing, scoring, weekly growth, CEO bonus, idle rule, config validation, photo validation, report markdown, ticker validation/defaults, close-countdown schedule, Discord message rendering/mentions/rate limit, awards and badges, standings, price records, alerts.
- **Integration** (`functions/test/`): calls the real Cloud Functions in the emulators as real signed-in users. Covers registration and approval, security rules (clients can't write cash/prices/pools), buying and selling, fees to the prize pool, posts, reactions, moderation, weekly close (allowance, CEO bonus, prize, pool top-up, idle players, double-close protection), the cron endpoint's secret, config changes, delisting, stock photos, tickers (defaults, uniqueness, cooldown, legacy backfill), Discord posts (captured by a local webhook server: mentions, rate limit + digest, close post, on/off), price alerts and notifications, the recap, awards, price history/records and the full reset.

Integration tests always use the `demo-fsm` project on `127.0.0.1`, so they can't touch the live Firebase project. They wipe the emulator before each test.

GitHub Actions runs typecheck + both suites on every push and pull request. A push to `main` only deploys to Pages if they pass. `npm run deploy:backend` also runs the full suite before deploying.

## Deploying

1. Create a Firebase project, enable **Authentication** (Email/Password and Google), **Firestore**, and upgrade to the **Blaze** plan (needed for Cloud Functions). Set a billing budget alert (e.g. £1).
2. `cp .firebaserc.example .firebaserc` and set your project id.
3. Set the cron secret: `npx firebase functions:secrets:set CRON_SECRET` (use a long random string).
4. `npm run deploy:backend` runs the tests, then deploys functions, rules and indexes. Region is `europe-west2`; change `REGION` in `functions/src/common.ts` and `NEXT_PUBLIC_FUNCTIONS_REGION` together.
5. Create `admins/<your uid>` in the Firestore console.
6. GitHub repo → Settings → Pages → Source: **GitHub Actions**. Add repository **variables** `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `NEXT_PUBLIC_FUNCTIONS_REGION`. Push to `main`.
7. In Firebase Auth → Settings → Authorized domains, add `<user>.github.io`.
8. For the automatic weekly close, add repository **secrets** `WEEKLY_CLOSE_URL` (the `weeklyCloseCron` function URL) and `CRON_SECRET`. It runs Sundays 20:00 UTC and skips itself if a close ran within `minHoursBetweenAutoCloses`. Admins can also close manually from the Admin page.
9. Discord (optional), see below.

### Discord

The market posts to one Discord channel through a webhook. There's no bot to host and nothing to pay for.

1. In Discord, open the channel's settings (⚙️ next to its name) → **Integrations** → **Webhooks** → **New Webhook**. Name it "Stonker" (and give it the icon from `web/public/icons/icon-512.png` if you like), then **Copy Webhook URL**. You need "Manage Webhooks" permission on the server.
2. Store it as a Functions secret: `npx firebase functions:secrets:set DISCORD_WEBHOOK_URL` and paste the URL. It is never written to Firestore (clients can read Firestore). Anyone with the URL can post to the channel, so treat it like a password; if it leaks, delete the webhook in Discord and make a new one.
3. `npm run deploy:backend`. This also creates an hourly Cloud Scheduler job for the digest (the first three jobs per billing account are free).
4. Admin page → **Discord** → **Send test message**.
5. Players link their account on their profile (account menu → My profile → Discord) by pasting their Discord user ID, so posts can @mention them.

Tune it under Admin → Config: `discordEnabled`, `discordBigTradePct` (default 0.4 = trades and shorts worth 40% of average net worth), `discordMaxPerHour`.

Locally, `scripts/ensure-test-secret.mjs` points the emulator's `DISCORD_WEBHOOK_URL` at a capture server the integration tests run. Put a real webhook URL in `functions/.secret.local` to see posts in Discord while using `npm run emulators`.

## Implementation decisions

These fill gaps the design doc left open:

- **Idle reactivation** is silent: signing in (or trading/posting) clears the idle flag. No back-pay.
- **Audit logging**: every admin action (approve, decline, delete post with the deleted text and an optional reason, delist with payouts, config changes with before/after, weekly close) writes to `auditLog`, shown on the Admin page.
- **Buy amounts include the fee**: "spend £100" costs exactly £100; the fee comes off the top and the rest hits the pool. Sell fees are deducted from the pool payout.
- **Net worth** marks holdings at the current spot price.
- **Weekly growth** uses the net worth at the start of the week (after last week's payouts, or starting cash for new joiners). CEO bonus counts as growth; this week's allowance is subtracted. Idle players can't win. If nobody is eligible, the prize pool rolls over.
- **Listing pool size** uses the average net worth of active players *including the newcomer*, so the first player's pool is sized from their own starting cash.
- **Delisting** pays holders shares × last price (no fee, no pool impact), removes the stock from trading and deactivates the account. The player's own holdings in other stocks stay put.
- **Report flags** have their own config: `flagMovePct` (weekly move), `flagOwnershipPct` (one holder's share of player-held shares, ignoring dust), `flagCollusionMinTrades` (both players trading each other's stock at least N times in a week).
- **Double-close protection**: the admin button sends the week it's closing, so a double click can't close two weeks; the cron endpoint enforces `minHoursBetweenAutoCloses`.
- **Full reset** (Admin page, type RESET): deletes all players, stocks, holdings, trades, posts, photos and reports, and restarts at week 1. Keeps sign-in accounts, admins, settings and the audit log. Active players go back to pending so an admin can re-approve them as fresh founders; delisted players are marked declined. It isn't one transaction, so don't run it mid-trading.
- **Tickers**: everyone gets a default from their name when listed (Joe Bloggs → JOE, then BLO, JBL…) and can pick their own 2–5 letter ticker from their stock page, once per `tickerChangeCooldownHours`. Unique across all stocks, including delisted ones. Stocks listed before tickers existed get the same defaults in listing order, saved the next time anyone lists or changes a ticker.
- **Close countdown** assumes the cron schedule in `weekly-close.yml` (Sundays 20:00 UTC, mirrored in `shared/src/schedule.ts`) and skips a Sunday the cron would skip after a recent manual close.
- **Preferences** (theme, sounds) are per device, in localStorage. Sounds are off by default.
- **Discord** posts big trades and shorts (≥ `discordBigTradePct` × average net worth, measured on the cash moved, or shares × pre-trade price for a short), listings, bankruptcies, all-time highs/lows (at most one each per stock per week, and only after a stock's first weekly close), price alerts and the weekly close with winners, index and awards. Closes, listings, bankruptcies and alerts always post; everything else is capped at `discordMaxPerHour` per clock hour and the overflow goes into an hourly digest. Mentions only ping players who linked their Discord ID; `allowed_mentions` never lets @everyone or a stray ID in a post ping anyone.
- **Weekly awards** (in the report, the close post and as profile badges): Biggest Mover (largest weekly % move, either way), Bag Holder (largest paper £ loss on one holding), Diamond Hands (longest unbroken holding without a sell, held since before the week started), Most Reacted Post, Worst Take (most 👎). Holdings under £1 are ignored. Cost basis and holding start are tracked on each holding; older holdings are rebuilt from trades on their next trade or close.
- **Recap**: `touch` returns "while you were away" after `recapAfterHours` (48h) without activity: net worth and rank change since your last session, who bought/sold/shorted your stock, closes and prizes you missed, alerts that fired.
- **Results screen** shows once per close per player (the first time you open the app after it, tracked by your session snapshot and per device), and from any report page. Confetti when you win the week or take #1 on the leaderboard (skipped under reduced motion).
- **Price alerts** fire once, in-app (a notification) and optionally as a Discord @mention, when the price reaches the target. A new alert must point away from the current price. Up to `maxActiveAlerts` (10) active per player.
- **Stock photos**: players set their own; admins can only remove someone else's (audit-logged). The server checks type (JPEG/PNG/WebP only, no SVG), magic bytes and size.
- The design doc's worked example lists "Buy £500 → £64.00 (+28%)". The AMM formula it specifies gives **£63.28 (+26.6%)**; the code follows the formula. The £100 buy (£52.53) and 10-share sell (£39.51) rows match.

## Security notes

- Firestore rules deny all client writes; cash, pools and prices are only written by functions.
- Game data is readable by approved players and admins only; pending users can read just their own registration.
- `weeklyCloseCron` is a public HTTPS endpoint guarded by a bearer secret (timing-safe compare, min 16 chars). Everything else is a callable that checks the caller's auth and, for admin actions, the `admins/{uid}` doc.
