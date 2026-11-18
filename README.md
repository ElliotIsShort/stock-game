# Friend Stock Market

Every player is a tradable stock. Players trade each other with play money against a constant-product AMM; prices move only from trades. A chronological feed mixes trades and posts so players can spin the story behind each move.

## Layout

| Path | What |
|---|---| 
| `shared/` | Pure game logic used by both sides: AMM (`amm.ts`), economy formulas (`economy.ts`), config defaults + validation (`config.ts`), Firestore types, weekly-report markdown |
| `functions/` | Firebase Cloud Functions. Every balance change (register/approve, trade, posts, reactions, weekly close, delist, config) runs here. Bundled with esbuild so `shared/` is inlined |
| `web/` | Next.js static export for GitHub Pages. Reads Firestore live; writes only through callable functions |
| `firestore.rules` | Clients can read game data but never write anything. Only the Admin SDK (functions) writes |
| `.github/workflows/` | Tests, then a Pages deploy on push to `main` |

### Firestore collections
The owner can run several independent games ("servers"), one per friend group. Nothing crosses between them. Each game's data lives under `servers/{code}` (a random 6-digit code that is also the document id):

```
servers/{code}                 name, status (active|archived), createdAt, closesAt (copy of meta/state.closesAt, for the scheduler), hasDiscordWebhook
  config/global  content/global  meta/state
  players/{uid}  stocks/{uid}  holdings/{uid}_{stockId}  shorts/{id}  trades/{id}  posts/{id}  photos/{uid}
  alerts/{id}  notifications/{id}                       private to their owner
  netWorthHistory/{uid}  netWorthSeries/{uid}_{week}  weeklyReports/week-NNNN
  discordOutbox/{id}  discordState/rate  private/discord  server-only (clients can never read them; the webhook URL lives in private/discord)
users/{uid}                    { serverIds } lookup cache kept by functions (membership itself is the player document)
registrations/{uid}  admins/{uid}  devlog/{id}  auditLog/{id}   global
system/maintenance             the maintenance-mode switch
```
Stock photos live in `photos/{uid}` as small (256 px, ≤200 KB) JPEG data URLs rather than in Cloud Storage, so there's no extra service to enable. They're kept out of `stocks/{uid}` so live price updates don't resend image data.

Holdings are stored flat as `holdings/{uid}_{stockId}` (with `uid`/`stockId` fields) rather than nested, so "all holders of a stock" is a single query.

## Local development

Needs Node 22+ and Java 21+ (for the Firestore emulator). On macOS: `brew install openjdk@21`, then add `export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"` to `~/.zshrc`.

```sh
npm install
cp web/.env.example web/.env.local      # set NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-fsm, NEXT_PUBLIC_USE_EMULATORS=true
npm run emulators                        # auth, firestore (8180), functions on the demo-fsm project
npm run dev:web                          # in another terminal
```

To make yourself admin, sign up in the app, then in the Emulator UI (http://127.0.0.1:4000/firestore) create an empty document `admins/<your uid>`. Then, in Admin → **Servers**, create a server (give it a name and a first close time, and choose default settings), register as a player like anyone else and approve yourself into it from **Pending sign-ups**.

If the Firebase CLI fails with "self-signed certificate in certificate chain" (corporate networks that inspect HTTPS), prefix commands with `NODE_OPTIONS=--use-system-ca`.

## Testing

```sh
npm test                  # everything: unit + integration
npm run test:unit         # pure game logic, ~1s, no Firebase needed
npm run test:integration  # starts the emulators, runzs the suite, shuts them down
```

- **Unit** (`shared/test/`, plus `web/test/`): AMM maths against the design doc's worked example, pool sizing and top-ups, starting cash, median listing, scoring, weekly growth, CEO bonus, idle rule, config validation, photo validation, report markdown, ticker validation/defaults, close-time maths (advance by whole weeks, legacy derivation, validation), net-worth series coalescing/downsampling, margin thresholds and minimal liquidation, Discord message rendering/mentions/rate limit, awards and badges, standings, price records, alerts, server codes (format, generator and collision retry), path helpers and the landing/visibility decision, plus the migration script's parity with `shared/`. `web/test/` has the concealment tests (a one-server player's pages contain no server name, switcher, picker or `?s=`, and nothing says "server" or "group") and a scan that fails on hand-built internal links.
- **Integration** (`functions/test/`): calls the real Cloud Functions in the emulators as real signed-in users. Covers registration and approval, security rules (clients can't write cash/prices/pools), buying and selling, fees to the prize pool, posts, reactions, moderation, weekly close (allowance, CEO bonus, prize, pool top-up, idle players, double-close protection), the close time and per-minute scheduler (due/not due, overlapping ticks, legacy state), net-worth points per change (who gets one, coalescing, no trigger loop), margin warnings/calls and forced liquidation (partial and bankrupt), password reset against the Auth emulator, config changes, delisting, stock photos, tickers (defaults, uniqueness, cooldown, legacy backfill), Discord posts (captured by a local webhook server: mentions, rate limit + digest, close post, on/off), price alerts and notifications, the recap, awards, price history/records the full reset, maintenance mode, and everything multi-server: isolation between servers (rules and functions), the same user in two servers, per-server names and tickers, approval into a chosen server and adding existing users, archiving, the per-server scheduler and margin sweep, per-server Discord webhooks (an event in one server never reaches another's channel), and the legacy-to-servers migration script (dry run, refusals, idempotency, resume, conflicts, rollback copy untouched).

Integration tests always use the `demo-fsm` project on `127.0.0.1`, so they can't touch the live Firebase project. They wipe the emulator before each test.

GitHub Actions runs typecheck + both suites on every push and pull request. A push to `main` only deploys to Pages if they pass. `npm run deploy:backend` also runs the full suite before deploying.

## Deploying

1. Create a Firebase project, enable **Authentication** (Email/Password and Google), **Firestore**, and upgrade to the **Blaze** plan (needed for Cloud Functions). Set a billing budget alert (see [Costs](#costs)).
2. `cp .firebaserc.example .firebaserc` and set your project id.
3. (No cron secret any more: the weekly close runs from the `closeScheduler` function.)
4. `npm run deploy:backend` runs the tests, then deploys functions, rules and indexes. Region is `europe-west2`; change `REGION` in `functions/src/common.ts` and `NEXT_PUBLIC_FUNCTIONS_REGION` together.
5. Create `admins/<your uid>` in the Firestore console.
6. GitHub repo → Settings → Pages → Source: **GitHub Actions**. Add repository **variables** `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `NEXT_PUBLIC_FUNCTIONS_REGION`. Push to `main`.
7. In Firebase Auth → Settings → Authorized domains, add the domain the site is served from (`stonker.net`, and/or `<user>.github.io`). Password reset links need it too.
8. The weekly close is automatic: `closeScheduler` (a Cloud Scheduler job, every minute) closes the week within a minute of `meta/state.closesAt` and moves it on 7 days. Set the time under Admin → Weekly close (it starts as the next Sunday 20:00 UTC). Admins can also close by hand there; closing early leaves the scheduled time alone. The old GitHub Actions cron is gone, so the `WEEKLY_CLOSE_URL` and `CRON_SECRET` repository secrets are no longer needed: delete them (GitHub → Settings → Secrets and variables → Actions), and optionally the `CRON_SECRET` Functions secret (`npx firebase functions:secrets:destroy CRON_SECRET`).
9. Discord (optional), see below.

### Password reset

Sign-in is Firebase email + password (and Google). "Forgot password?" on the sign-in screen and **Change password** in the account menu both send Firebase's password reset email, using **Firebase's default template and sender** (nothing to configure). The sign-in form always says "If an account exists for that email, a reset link is on its way", so it can't be used to find out who's registered.

For the link to bring people back to the app, `stonker.net` must be listed under Firebase console → **Authentication → Settings → Authorised domains** (if it isn't, the email still goes out, just without the return link). These emails come from a `noreply@<project>.firebaseapp.com` address and may land in spam; tell players to check there.

### Discord
Each server posts to its own Discord channel through its own webhook. There's no bot to host and nothing to pay for. A server with no webhook set posts nothing, and **never falls back to another server's webhook**.
1. In Discord, open the channel's settings (⚙ next to its name) → **Integrations** → **Webhooks** → **New Webhook**. Name it "Stonker" (and give it the icon from `web/public/icons/icon-512.png` if you like), then **Copy Webhook URL**. You need "Manage Webhooks" permission on the Discord server.
2. Admin page → **Servers** → that server → **Set webhook**, paste the URL. It's saved in a server-only Firestore document (`servers/{code}/private/discord`) that no client can read, and it can't be shown again (the UI only says "set" or "not set"). Anyone with the URL can post to the channel, so treat it like a password; if it leaks, delete the webhook in Discord and set a new one. There is no Functions secret any more (`DISCORD_WEBHOOK_URL` is retired: after the cutover you can run `npx firebase functions:secrets:destroy DISCORD_WEBHOOK_URL`).
3. `npm run deploy:backend`. This also creates an hourly Cloud Scheduler job for the digest (one digest per active server). With `closeScheduler` that's two jobs; the first three per billing account are free, so don't add a third.
4. Select the server in Admin → **Discord** → **Send test message**.
5. Players link their account on their profile (account menu → My profile → Discord) by pasting their Discord user ID, so posts can @mention them. The link is per server, so mentions only resolve in the server that sent them.
Tune it under Admin → Config (per server): `discordEnabled`, `discordBigTradePct` (default 0.4 = trades and shorts worth 40% of average net worth), `discordMaxPerHour`.
Locally the integration tests point each server's webhook at a capture server on `127.0.0.1` (only allowed inside the emulator). To see posts in a real channel while using `npm run emulators`, set a real webhook URL on a server from the Admin page.
### Multiple servers
- **Only the admin creates servers** (Admin → Servers). The code is generated for you and never changes; the name can be renamed. Archive a server to make it read-only (no trades, posts or closes; the scheduler and Discord skip it); unarchive to reopen it. Deleting servers isn't supported.
- **One login per person.** Registration is global and unchanged. When you approve someone, the dropdown on their row picks the server they join; **Add an existing user to a server** puts someone who already plays (for example you) into another one, with a separate player, cash, stock, ticker and, if you like, a different display name.
- **URLs** use `?s=<code>` (for example `/market/?s=482915`), everywhere. This is GitHub Pages: a path segment chosen at runtime can't be prerendered, so there are no path-style URLs. Links are built through `ServerLink` / `serverHref()`.

## Migrating the existing game into the first server (cutover checklist)
The live game becomes the first server (named `DYF`). It's a **copy**: the old top-level collections stay exactly as they are as your rollback copy. Plan a short downtime, and **not within 2 hours of the weekly close**.

Before you start: `gcloud auth application-default login` (the script uses your Google credentials), and a clean working tree on the commit you will deploy.

1. **The maintenance-mode build must already be live (it is, if you deployed and tested it earlier).** Do NOT run `npm run deploy:backend` for this step from a working tree that contains the multi-server code: that command deploys the new functions and rules straight away, which belongs in step 3, *after* the migration. Only if maintenance mode has never been deployed, check out the commit that has it but not the multi-server changes, deploy that, and come back. Check Admin → **Maintenance mode** works (you can't trade or post while it's on, and everyone sees a banner). Warn the players of a short downtime.
2. **Turn maintenance on** (Admin → Maintenance mode). Then run the migration:
   ```sh
   node scripts/migrate-to-servers.mjs --project <firebase-project-id> --name DYF --backup-dir ./migration-backup            # dry run: reads only, writes nothing
   node scripts/migrate-to-servers.mjs --project <firebase-project-id> --name DYF --backup-dir ./migration-backup --execute  # the real thing
   ```
   The dry run prints exactly what it would copy and the server code it would use (the real run uses the same one). The real run: checks maintenance is on and the next close is more than 2 hours away, backs up every top-level collection to JSON files in `--backup-dir`, creates the server, copies the 17 collections with ids and fields unchanged (never overwriting anything that already exists), creates `users/{uid}` docs, then verifies per-collection counts, every document and the totals (cash, pools, prices, prize pool, week). It must print **PASS** and exit 0. Anything else: stop, don't deploy, and tell me what it printed (the legacy data is untouched). It is safe to re-run after a partial failure. Keep the backup folder somewhere safe.
3. **Only now deploy functions, rules, indexes and web together** (the new code expects the new paths, so this must come after a PASS in step 2): `npm run deploy:backend`, then commit and push the web build. Wait for the new Firestore indexes to finish building (Firebase console → Firestore → Indexes: `servers (status, closesAt)`, `auditLog (serverId, createdAt)` and the `players.marginCall.deadline` collection-group index must all be *Enabled*) before turning maintenance off, or the per-minute scheduler will log index errors.
4. **In Admin, open the new server and re-enter its Discord webhook** (Servers → Set webhook). The old Functions secret isn't copied. Then **Send test message** (Discord section).
5. **Test as a player and as admin**: sign in as a normal player (or use *View as player*): you should see no server name or `?s=` anywhere. Check the feed, market, a trade, the leaderboard and the reports. Then **turn maintenance off** and tell players to reload (the app updates its service worker cache on the next load).
6. **Rollback** (if something is wrong; decide quickly, because only activity *after* the cutover would be missing from the old data): turn maintenance on, redeploy the previous commit's functions, rules and web (`git checkout <previous-commit>`, `npm run deploy:backend`, push the web). The legacy collections are intact, so the old code carries on as before. The new `servers/*` and `users/*` documents are ignored by the old code, and the old rules deny them. The local backup (step 2) is a second safety net.

Create the second server only after the first has run normally for a while, from Admin → Servers (name, first close time, and an explicit choice of default settings or a copy of the first server's), then **Set webhook**, then approve people into it (or **Add an existing user to a server** for yourself).

**Only after a couple of weeks** of the new setup proving itself, you can reclaim the space with `node scripts/delete-legacy.mjs --project <id>`. It asks you to type a confirmation phrase, refuses unless the migration is marked complete and the new copy is at least as big as what it would delete, and never touches `servers`, `users`, `registrations`, `admins`, `devlog` or `auditLog`. After that there is no rollback to the old layout.

## Costs

The aim is £0 a month. The project is on the Blaze plan (needed for Cloud Functions) but everything is sized to stay inside the free quotas:

| Free quota | Expected use (10–20 players) |
|---|---|
| Firestore: 50k reads, 20k writes, 20k deletes per day | `closeScheduler`: ~2,900 reads/day (2 per minute while idle: one query on `servers` for due closes and one collection-group query for overdue margin calls; independent of how many servers exist). Each trade: the trade itself plus `onStockTraded` (~10–60 reads, about one write per affected player; see `docs/ARCHITECTURE.md` §5.2). Clients: live listeners on the market collections, plus the net-worth series only on Portfolio and the Player tab. Each user listens to only the one server they are viewing, so reads scale with that server's size, not the number of servers. Firestore rules' `exists()` lookups (server membership) also count as reads, but are cached within a request. A busy day of 100 trades and a dozen players online is roughly 10–20k reads and 1–2k writes. |
| Cloud Functions: 2M invocations/month | ~43k/month for `closeScheduler`, ~720 for `discordDigest`, plus a few per trade (`onStockTraded`, `checkPriceAlerts`, `discordDeliver`). |
| Cloud Scheduler: 3 jobs per billing account | 2 (`discordDigest`, `closeScheduler`). Don't add a third. |

Guardrails in the code: every trigger is scoped to a specific change (a trade's `lastTrade` marker, a price change, a new outbox doc) and never writes the collection it listens to; no polling loops; scheduled functions don't retry; `maxInstances: 5`.

**Set a budget alert.** Firebase has no hard spending cap. In Google Cloud console → Billing → Budgets & alerts, create a budget for the project (e.g. £5) with email alerts at 50%, 90% and 100%.

**Clean up old deploy images.** Each functions deploy leaves a container image in Artifact Registry, the only thing likely to cost a few pence a month. Firebase CLI 14+ can set a cleanup policy (it may also offer to on deploy):

```sh
npx firebase functions:artifacts:setpolicy --location europe-west2 --days 1
```

## Implementation decisions

These fill gaps the design doc left open:

- **Idle reactivation** is silent: signing in (or trading/posting) clears the idle flag. No back-pay.
- **Maintenance mode** (Admin → Maintenance mode, a global `system/maintenance` switch): while on, every mutating callable fails with "The game is being upgraded, back shortly", the scheduler, digest and triggers skip their work, and everyone sees a banner. It exists so the migration can run with nothing writing; leave it on near a weekly close and the close waits (the scheduler resumes when you turn it off).
- **Audit logging**: every admin action (approve, decline, delete post with the deleted text and an optional reason, delist with payouts, config changes with before/after, weekly close) writes to `auditLog`, shown on the Admin page.
- **Buy amounts include the fee**: "spend £100" costs exactly £100; the fee comes off the top and the rest hits the pool. Sell fees are deducted from the pool payout.
- **Net worth** marks holdings at the current spot price.
- **Weekly growth** uses the net worth at the start of the week (after last week's payouts, or starting cash for new joiners). CEO bonus counts as growth; this week's allowance is subtracted. Idle players can't win. If nobody is eligible, the prize pool rolls over.
- **Listing pool size** uses the average net worth of active players *including the newcomer*, so the first player's pool is sized from their own starting cash.
- **Delisting** pays holders shares × last price (no fee, no pool impact), removes the stock from trading and deactivates the account. The player's own holdings in other stocks stay put.
- **Report flags** have their own config: `flagMovePct` (weekly move), `flagOwnershipPct` (one holder's share of player-held shares, ignoring dust), `flagCollusionMinTrades` (both players trading each other's stock at least N times in a week).
- **Double-close protection**: the admin button and every scheduler tick send the week they saw, and the close re-checks it inside its transaction, so a double click or overlapping ticks can't close two weeks.
- **Full reset** (Admin page, type RESET) resets the selected server only: deletes its players, stocks, holdings, trades, posts, photos and reports, and restarts at week 1. Keeps sign-in accounts, admins, the server itself, its settings and webhook, and the audit log. Active players who aren't in another server go back to pending so an admin can re-approve them as fresh founders (people also in another server stay approved: add them back with "Add an existing user"); delisted players are marked declined. It isn't one transaction, so don't run it mid-trading.
- **Tickers**: everyone gets a default from their name when listed (Joe Bloggs → JOE, then BLO, JBL…) and can pick their own 2–5 letter ticker from their stock page, once per `tickerChangeCooldownHours`. Unique within a server (across all its stocks, including delisted ones); the same ticker can exist in another server. Stocks listed before tickers existed get the same defaults in listing order, saved the next time anyone lists or changes a ticker.
- **Close time** is game state (`meta/state.closesAt`), set by an admin and moved on exactly 7 days after each scheduled close (whole weeks are skipped after an outage). The countdown reads it, and shows "closing now…" for the minute until the scheduler runs. Game state from before this gets the next Sunday 20:00 UTC once.
- **Preferences** (theme, sounds) are per device, in localStorage. Sounds are off by default.
- **Discord** posts big trades and shorts (≥ `discordBigTradePct` × average net worth, measured on the cash moved, or shares × pre-trade price for a short), listings, bankruptcies, all-time highs/lows (at most one each per stock per week, and only after a stock's first weekly close), price alerts and the weekly close with winners, index and awards. Closes, listings, bankruptcies and alerts always post; everything else is capped at `discordMaxPerHour` per clock hour and the overflow goes into an hourly digest. Mentions only ping players who linked their Discord ID; `allowed_mentions` never lets @everyone or a stray ID in a post ping anyone.
- **Weekly awards** (in the report, the close post and as profile badges): Biggest Mover (largest weekly % move, either way), Bag Holder (largest paper £ loss on one holding), Diamond Hands (longest unbroken holding without a sell, held since before the week started), Most Reacted Post, Worst Take (most 👎). Holdings under £1 are ignored. Cost basis and holding start are tracked on each holding; older holdings are rebuilt from trades on their next trade or close.
- **Recap**: `touch` returns "while you were away" after `recapAfterHours` (48h) without activity: net worth and rank change since your last session, who bought/sold/shorted your stock, closes and prizes you missed, alerts that fired.
- **Results screen** shows once per close per player (the first time you open the app after it, tracked by your session snapshot and per device), and from any report page. Confetti when you win the week or take #1 on the leaderboard (skipped under reduced motion).
- **Margin calls** (shorts only): when buying back all your shorts would cost at least `shortWarnPct` (80%) of your cash you're warned once; above 100% you're margin called with 7 days to raise the shortfall (feed post, notification, Discord, banner on Portfolio and the account menu). Closing a short you can't afford is refused with the shortfall and a "sell enough to cover" prompt. After the deadline the scheduler force-sells the minimum (largest holding first, normal fees) and covers the shorts; only if that's not enough does the old bankruptcy rule apply. Forced trades show as FORCED SALE and are listed in the weekly report.
- **Price alerts** fire once, in-app (a notification) and optionally as a Discord @mention, when the price reaches the target. A new alert must point away from the current price. Up to `maxActiveAlerts` (10) active per player.
- **Stock photos**: players set their own; admins can only remove someone else's (audit-logged). The server checks type (JPEG/PNG/WebP only, no SVG), magic bytes and size.
- The design doc's worked example lists "Buy £500 → £64.00 (+28%)". The AMM formula it specifies gives **£63.28 (+26.6%)**; the code follows the formula. The £100 buy (£52.53) and 10-share sell (£39.51) rows match.

## Security notes

- Firestore rules deny all client writes; cash, pools and prices are only written by functions.
- A server's game data is readable by its members and by admins only (membership = a player document in that server, checked by the rules, never the `users` cache); config and rules content are no longer readable by every signed-in user. Pending users can read just their own registration. `private/*`, `discordOutbox` and `discordState` are never readable by clients. The old top-level game collections are denied to everyone.
- Every game function takes a `serverId`, validated against `^[1-9][0-9]{5}$`, and checks membership before touching anything. A stranger gets the same "not part of this game" answer whether or not a code exists. `?s=` in a URL is not a secret and not access control: rules and functions are the boundary.
- There's no public HTTPS endpoint. Everything is a callable that checks the caller's auth and, for admin actions, the `admins/{uid}` doc, or a Firestore/scheduled trigger.
