/**
 * Rentshare — Cloudflare Worker entry point.
 *
 * Serves the static frontend from /public (via the ASSETS binding)
 * and exposes a small API surface under /api/* backed by D1.
 *
 * This is a starting skeleton — each endpoint below maps to a step
 * in the finalized flow spec / database schema, with the real
 * business logic (timing jobs, name-matching, Paystack calls) left
 * as clearly marked TODOs to fill in next.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    // Everything else falls through to the static site in /public
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const { pathname } = url;

  // GET /api/listings?city=Lagos&tier=shared_space&gender=female
  if (pathname === '/api/listings' && request.method === 'GET') {
    return listListings(request, env, url);
  }

  // GET /api/listings/:id
  const listingMatch = pathname.match(/^\/api\/listings\/([\w-]+)$/);
  if (listingMatch && request.method === 'GET') {
    return getListing(env, listingMatch[1]);
  }

  // POST /api/bookings  — creates a booking (Step A in the flow spec)
  if (pathname === '/api/bookings' && request.method === 'POST') {
    return createBooking(request, env);
  }

  // POST /api/listings — host submits a new listing (List your space page)
  if (pathname === '/api/listings' && request.method === 'POST') {
    return createListing(request, env);
  }

  // POST /api/users/verify-bank — Paystack Resolve cross-check (Step A″)
  if (pathname === '/api/users/verify-bank' && request.method === 'POST') {
    return verifyBank(request, env);
  }

  return json({ error: 'Not found' }, 404);
}

/**
 * Gender-matching enforcement happens HERE, at query time — a guest
 * never even sees a listing that doesn't match their gender for the
 * Shared Space tier. This is the DB-query-level implementation of
 * Step A from the flow spec.
 */
async function listListings(request, env, url) {
  const city = url.searchParams.get('city');
  const tier = url.searchParams.get('tier'); // 'private_room' | 'shared_space'
  const gender = url.searchParams.get('gender'); // required if tier=shared_space

  let query = `SELECT * FROM listings WHERE status = 'active'`;
  const binds = [];

  if (city) {
    query += ` AND city = ?`;
    binds.push(city);
  }
  if (tier) {
    query += ` AND tier = ?`;
    binds.push(tier);
  }
  if ((tier === 'shared_space' || tier === 'shared_room_with_host') && gender) {
    const allocation = gender === 'female' ? 'female_only' : 'male_only';
    query += ` AND gender_allocation = ?`;
    binds.push(allocation);
  }

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json({ listings: results });
}

async function getListing(env, id) {
  const listing = await env.DB.prepare(`SELECT * FROM listings WHERE id = ?`).bind(id).first();
  if (!listing) return json({ error: 'Listing not found' }, 404);
  return json({ listing });
}

/**
 * Creates a booking. Enforces the gender-match rule as a hard
 * application-level check before insert (defense in depth — the
 * primary enforcement is the search filter above, this is the
 * backstop in case a listing ID is booked directly).
 *
 * TODO: wire up Paystack payment initialization here, and set
 * is_same_day_booking based on check_in_date vs now() to drive the
 * presence-confirmation timing rules from the flow spec.
 */
async function createBooking(request, env) {
  const body = await request.json();
  const { listing_id, guest_id, check_in_date, check_out_date, check_in_time, room_share_consent } = body;

  const listing = await env.DB.prepare(`SELECT * FROM listings WHERE id = ?`).bind(listing_id).first();
  if (!listing) return json({ error: 'Listing not found' }, 404);

  const guest = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(guest_id).first();
  if (!guest) return json({ error: 'Guest not found' }, 404);

  // Hard gender-match check — applies to BOTH shared tiers, mirrors the CHECK constraint intent from the schema notes
  if (listing.tier === 'shared_space' || listing.tier === 'shared_room_with_host') {
    const requiredGender = listing.gender_allocation === 'female_only' ? 'female' : 'male';
    if (guest.gender !== requiredGender) {
      return json({ error: 'This listing does not match your gender allocation.' }, 403);
    }
  }

  // Step A''' — Shared Room (with Host) requires standalone, explicit guest consent.
  // Cannot be defaulted, bundled, or skipped — the booking is rejected without it.
  if (listing.tier === 'shared_room_with_host' && room_share_consent !== true) {
    return json({ error: 'Explicit consent is required to book a room shared directly with the host.' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const isSameDay = check_in_date === now.slice(0, 10);

  await env.DB.prepare(`
    INSERT INTO bookings (
      id, listing_id, guest_id, host_id, check_in_date, check_out_date,
      check_in_time, guest_gender_snapshot, is_same_day_booking, status,
      amount_total, platform_commission, host_payout_amount,
      room_share_consent, room_share_consent_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, listing_id, guest_id, listing.host_id, check_in_date, check_out_date,
    check_in_time, guest.gender, isSameDay ? 1 : 0,
    0, 0, 0, // TODO: compute real amounts from listing.price_per_night * nights, minus commission
    listing.tier === 'shared_room_with_host' ? 1 : null,
    listing.tier === 'shared_room_with_host' ? now : null,
    now, now
  ).run();

  return json({ booking_id: id, status: 'requested' }, 201);
}

/**
 * Host submits the "List your space" form. No login system exists yet,
 * so this finds-or-creates the host's user record (matched by phone,
 * since that's the one field guaranteed present) and creates the
 * listing in the same request.
 *
 * New listings save with status='pending_review', NOT 'active' —
 * verification (Paystack Resolve name-match, ID checks) isn't wired
 * into this flow yet, so nothing should go live automatically until
 * that's built. A manual review step (or an admin approval endpoint,
 * still TODO) is what flips status to 'active'.
 */
async function createListing(request, env) {
  const body = await request.json();
  const {
    full_name, phone, host_gender, bank_account_number, bank_code,
    tier, title, city, area, address, price_per_night,
    gender_allocation, lockable_door, bathroom_access, access_hours, max_stay_nights,
    allows_smoking, allows_pets, allows_alcohol,
  } = body;

  if (!full_name || !phone || !host_gender || !bank_account_number || !bank_code) {
    return json({ error: 'Missing required host details.' }, 400);
  }
  if (!title || !city || !area || !address || !price_per_night) {
    return json({ error: 'Missing required listing details.' }, 400);
  }
  if ((tier === 'shared_space' || tier === 'shared_room_with_host') && !gender_allocation) {
    return json({ error: 'Gender allocation is required for this listing type.' }, 400);
  }

  // Find or create the host user record
  let host = await env.DB.prepare(`SELECT * FROM users WHERE phone = ?`).bind(phone).first();

  if (!host) {
    // Bank account must be unique — check before insert to give a clear error
    // rather than letting the UNIQUE constraint throw a raw SQL error.
    const existingBank = await env.DB.prepare(`SELECT id FROM users WHERE bank_account_number = ?`).bind(bank_account_number).first();
    if (existingBank) {
      return json({ error: 'This bank account is already linked to a Rentshare account.' }, 409);
    }

    const hostId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO users (id, full_name, phone, gender, bank_account_number, bank_code, verification_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'unverified', ?, ?)
    `).bind(hostId, full_name, phone, host_gender, bank_account_number, bank_code, now, now).run();

    host = { id: hostId };
  }

  const listingId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO listings (
      id, host_id, tier, title, city, area, address, price_per_night,
      gender_allocation, lockable_door, bathroom_access, access_hours, max_stay_nights,
      allows_smoking, allows_pets, allows_alcohol, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
  `).bind(
    listingId, host.id, tier, title, city, area, address, price_per_night,
    gender_allocation || null,
    lockable_door ? 1 : 0,
    bathroom_access || 'shared',
    access_hours || '24h',
    max_stay_nights || null,
    allows_smoking ? 1 : 0,
    allows_pets ? 1 : 0,
    allows_alcohol ? 1 : 0,
    now, now
  ).run();

  return json({ listing_id: listingId, status: 'pending_review' }, 201);
}

/**
 * Step A″ from the flow spec — Paystack Resolve Account Number
 * cross-check. Requires PAYSTACK_SECRET_KEY as a Worker secret
 * (wrangler secret put PAYSTACK_SECRET_KEY).
 */
async function verifyBank(request, env) {
  const { account_number, bank_code, full_name } = await request.json();

  const resolveUrl = `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`;
  const resp = await fetch(resolveUrl, {
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
  });
  const data = await resp.json();

  if (!data.status) {
    return json({ error: 'Could not resolve account. Check the details and try again.' }, 400);
  }

  const resolvedName = data.data.account_name;

  // TODO: replace this naive check with real fuzzy matching
  // (e.g. Jaro-Winkler or token-set comparison) per the flow spec's
  // "bank name vs ID document name" required-match rule.
  const isCloseMatch = namesRoughlyMatch(resolvedName, full_name);

  return json({
    resolved_name: resolvedName,
    match_status: isCloseMatch ? 'matched' : 'flagged',
  });
}

function namesRoughlyMatch(a, b) {
  const normalize = (s) => s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const tokensA = new Set(normalize(a));
  const tokensB = new Set(normalize(b));
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap++;
  return overlap >= 2; // at least first + last name token overlap
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
