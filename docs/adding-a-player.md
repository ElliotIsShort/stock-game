# Adding a new player

How someone goes from "never heard of it" to trading. Nothing needs doing in the Firebase console for an ordinary player — the app creates their login and an admin approves them in the app. The Firebase console is only needed to make someone an **admin**.

Site: <https://elliotisshort.github.io/stock-game/>

## 1. They create an account (the player)

1. Open the site and choose **Create an account** (email + password, at least 6 characters) or **Continue with Google**.
2. On **Join the market**, pick a display name. This is the name their stock trades under, 2–30 characters, and must be unique.
3. They'll see **Waiting for approval**. They have no cash or stock yet.

If they get an error signing in with Google on a new domain, check the domain is listed in Firebase console → Authentication → Settings → **Authorized domains** (`elliotisshort.github.io` already is).

## 2. You approve them (an admin)

1. Open **Admin** → **Pending sign-ups**.
2. Check the name and email, then **Approve** (or **Decline**; a declined person can ask again).

Approval does everything in one step:

- Creates their player with starting cash: base cash + one weekly allowance for every week already played (so a week-3 joiner gets £1,000 + 2 × £200).
- Lists their stock at the **median** current price (or the base price if they're the first), with a pool sized to the current average net worth.
- Posts "*Name* has listed at £X" in the feed and writes an audit-log entry.

## 3. They start playing

- They refresh and land on the feed with their cash in the top bar.
- On **Portfolio → Your stock** (or their own stock page) they can **Add a photo**. Photos are cropped square and shrunk in the browser, so any phone photo works.
- They can trade anyone except themselves, and post about anyone including themselves.

## Making someone an admin

Admins can approve people, delete posts, remove photos, delist, change settings, close the week and reset the game. To make someone an admin:

1. Get their **User UID**: Firebase console → **Authentication** → **Users**, find their email, copy the UID.
2. Firebase console → **Firestore Database** → **Data** → collection **`admins`** → **Add document**.
3. Set **Document ID** to their UID. Leave the fields empty (or add any dummy field if the console insists) and save.
4. They refresh the site and an **Admin** tab appears.

An admin doesn't have to be a player. If they want to play too, they register like anyone else and approve themselves.

To remove an admin, delete their `admins/<uid>` document.

## Removing someone

| Situation | What to do |
|---|---|
| They've just stopped playing | Nothing. After 4 weeks without signing in or trading they're marked idle (no allowance, not ranked) and reactivate automatically when they come back. |
| They want out entirely | **Admin → Delist a player.** Everyone holding their stock is paid out at the last price and the stock stops trading. |
| They should never have had an account | Decline them if they're pending. To delete the login itself: Firebase console → Authentication → Users → ⋮ → **Delete account**. |

## Troubleshooting

- **Stuck on "Waiting for approval"**: an admin hasn't approved them yet. Check Admin → Pending sign-ups.
- **"That name is taken"**: someone else pending or approved already has it (case-insensitive). Pick another.
- **Approved but still sees the join screen**: ask them to refresh. If it persists, check `players/<uid>` exists in Firestore.
- **Admin tab missing**: the `admins` document ID must exactly match their UID (not their email).
