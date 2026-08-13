# Rentshare — Shortlets & Rooms (Cloudflare Workers + D1)

## What's in this scaffold

```
rentshare-app/
├── wrangler.toml           — Cloudflare Worker config
├── migrations/0001_init.sql — D1 schema (9 tables, matches the flow spec)
├── src/index.js             — Worker: serves the site + API routes
├── public/
│   ├── index.html            — Homepage
│   ├── styles.css            — Design system (light mode, matches the mockups)
│   └── app.js                 — Fetches listings from the API
└── README.md                — You are here
```

This is a **starting skeleton**, not a finished app — it's wired end-to-end (site → API → database) with real, working plumbing, but several pieces are intentionally left as `TODO` comments in `src/index.js` for you to fill in as you go: Paystack payment initialization, the presence/checkout timing jobs, and proper fuzzy name-matching.

## First-time setup

1. **Install Wrangler** (Cloudflare's CLI), if you don't have it:
   ```
   npm install -g wrangler
   ```

2. **Log in to Cloudflare:**
   ```
   wrangler login
   ```

3. **Create the D1 database:**
   ```
   wrangler d1 create rentshare-db
   ```
   This prints a `database_id` — copy it into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

4. **Run the migration** to create all 9 tables:
   ```
   wrangler d1 migrations apply rentshare-db --local
   ```
   (Drop `--local` once you're ready to apply it to the real, remote database.)

5. **Add your Paystack secret key** (needed for the `/api/users/verify-bank` route):
   ```
   wrangler secret put PAYSTACK_SECRET_KEY
   ```

## Running locally

```
wrangler dev
```

This starts a local server (usually `http://localhost:8787`) serving the site and API together, backed by your local D1 database. The homepage will show placeholder listing cards until you insert real rows into the `listings` table (the local D1 database starts empty).

## Adding a test listing

While `wrangler dev --local` is running, in another terminal:

```
wrangler d1 execute rentshare-db --local --command "
INSERT INTO users (id, full_name, phone, gender, bank_account_number, bank_code, verification_status)
VALUES ('host-1', 'Test Host', '08000000000', 'female', '0123456789', '058', 'bank_verified');

INSERT INTO listings (id, host_id, tier, title, city, area, address, price_per_night, gender_allocation, status)
VALUES ('listing-1', 'host-1', 'shared_space', 'Sitting room stay, Surulere', 'Lagos', 'Surulere', '12 Test Street', 7000, 'female_only', 'active');
"
```

Refresh the homepage — the real card should now replace the placeholder.

## Deploying

```
wrangler deploy
```

## Where to go next

- Fill in the `TODO`s in `src/index.js`: Paystack transaction initialization for bookings, and the scheduled timing logic (presence confirmations at T-24h, checkout confirmations at T-1h) — these are best built as [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) that scan `bookings` for rows crossing a time threshold.
- Build out the remaining pages referenced in the bottom nav (`/search.html`, `/bookings.html`, `/chats.html`, `/profile.html`, `/list-your-space.html`) — the listing form mockup and safety flow spec you already have are the source of truth for what each needs.
- Replace the naive `namesRoughlyMatch()` token-overlap check in `src/index.js` with a real fuzzy-matching library once you're ready — it's a placeholder that catches the obvious cases but isn't production-grade.
