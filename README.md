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

`players/{uid}`, `stocks/{uid}`, `holdings/{uid}_{stockId}`, `trades/{id}`, `posts/{id}`, `photos/{uid}`, `registrations/{uid}`, `weeklyReports/week-NNNN`, `config/global`, `meta/state` (current week, prize pool), `admins/{uid}`, `auditLog/{id}`.

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

- **Unit** (`shared/test/`): AMM maths against the design doc's worked example, pool sizing and top-ups, starting cash, median listing, scoring, weekly growth, CEO bonus, idle rule, config validation, photo validation, report markdown.
- **Integration** (`functions/test/`): calls the real Cloud Functions in the emulators as real signed-in users. Covers registration and approval, security rules (clients can't write cash/prices/pools), buying and selling, fees to the prize pool, posts, reactions, moderation, weekly close (allowance, CEO bonus, prize, pool top-up, idle players, double-close protection), the cron endpoint's secret, config changes, delisting, stock photos and the full reset.

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
- **Stock photos**: players set their own; admins can only remove someone else's (audit-logged). The server checks type (JPEG/PNG/WebP only, no SVG), magic bytes and size.
- The design doc's worked example lists "Buy £500 → £64.00 (+28%)". The AMM formula it specifies gives **£63.28 (+26.6%)**; the code follows the formula. The £100 buy (£52.53) and 10-share sell (£39.51) rows match.

## Security notes

- Firestore rules deny all client writes; cash, pools and prices are only written by functions.
- Game data is readable by approved players and admins only; pending users can read just their own registration.
- `weeklyCloseCron` is a public HTTPS endpoint guarded by a bearer secret (timing-safe compare, min 16 chars). Everything else is a callable that checks the caller's auth and, for admin actions, the `admins/{uid}` doc.
