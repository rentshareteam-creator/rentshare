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

    // Serve uploaded listing photos out of R2
    if (url.pathname.startsWith('/photos/')) {
      const key = url.pathname.replace('/photos/', '');
      return servePhoto(env, key);
    }

    // Everything else falls through to the static site in /public
    return env.ASSETS.fetch(request);
  },

  // Runs every 15 minutes (see wrangler.toml [triggers]). Drives the
  // presence-confirmation safety flow: triggers new prompts, re-triggers
  // for ongoing multi-night stays every 48h, and marks overdue,
  // unanswered ones as no_response (never auto-confirmed, never
  // auto-flagged — silence stays neutral, per the finalized flow spec).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPresenceConfirmationSweep(env));
    ctx.waitUntil(runCheckoutConfirmationSweep(env));
  },
};

async function runPresenceConfirmationSweep(env) {
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. First-time trigger: confirmed bookings within 24h of check-in
  //    (same-day bookings will always match this immediately) that don't
  //    have a cycle-1 presence_confirmation yet.
  const dueForFirstCheck = await env.DB.prepare(`
    SELECT b.* FROM bookings b
    WHERE b.status = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM presence_confirmations pc WHERE pc.booking_id = b.id AND pc.cycle_number = 1)
      AND (julianday(b.check_in_date || ' ' || b.check_in_time) - julianday('now')) <= 1.0
  `).all();

  for (const booking of dueForFirstCheck.results) {
    const deadline = new Date(`${booking.check_in_date}T${booking.check_in_time}:00Z`);
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO presence_confirmations (id, booking_id, cycle_number, triggered_at, deadline_at, resulted_in_flag)
      VALUES (?, ?, 1, ?, ?, 0)
    `).bind(id, booking.id, nowIso, deadline.toISOString()).run();
  }

  // 2. Re-trigger every 48h for ongoing multi-night stays still within their booked dates.
  const dueForRetrigger = await env.DB.prepare(`
    SELECT b.id AS booking_id, MAX(pc.cycle_number) AS last_cycle, MAX(pc.triggered_at) AS last_triggered
    FROM bookings b
    JOIN presence_confirmations pc ON pc.booking_id = b.id
    WHERE b.status IN ('presence_confirmed', 'checked_in')
      AND b.check_out_date >= date('now')
    GROUP BY b.id
    HAVING (julianday('now') - julianday(last_triggered)) >= 2.0
  `).all();

  for (const row of dueForRetrigger.results) {
    const nextCycle = row.last_cycle + 1;
    const deadline = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO presence_confirmations (id, booking_id, cycle_number, triggered_at, deadline_at, resulted_in_flag)
      VALUES (?, ?, ?, ?, ?, 0)
    `).bind(id, row.booking_id, nextCycle, nowIso, deadline.toISOString()).run();
  }

  // 3. Overdue, unanswered prompts: mark as no_response — never auto-confirmed,
  //    never auto-flagged. Booking moves to presence_unconfirmed (visible to
  //    the guest) and the host's non_response_count increments so a repeat
  //    pattern is reviewable later, even though no single miss triggers anything.
  const overdue = await env.DB.prepare(`
    SELECT pc.id, pc.booking_id, b.host_id
    FROM presence_confirmations pc
    JOIN bookings b ON pc.booking_id = b.id
    WHERE pc.host_response IS NULL AND pc.deadline_at < ?
  `).bind(nowIso).all();

  for (const row of overdue.results) {
    await env.DB.prepare(`UPDATE presence_confirmations SET host_response = 'no_response', response_at = ? WHERE id = ?`)
      .bind(nowIso, row.id).run();

    await env.DB.prepare(`UPDATE bookings SET status = 'presence_unconfirmed', updated_at = ? WHERE id = ? AND status IN ('confirmed', 'presence_confirmed')`)
      .bind(nowIso, row.booking_id).run();

    await env.DB.prepare(`UPDATE users SET non_response_count = non_response_count + 1 WHERE id = ?`)
      .bind(row.host_id).run();
  }
}

/**
 * Runs alongside the presence sweep. Handles the final safety-flow
 * step: pre-checkout confirmation. Host confirms property condition,
 * guest confirms belongings — answers stay hidden from each other
 * until both have responded (this endpoint never exposes one party's
 * answer to the other). No deadline_at column exists on this table,
 * so the 2h grace period from the flow spec is computed from
 * triggered_at instead of an exact checkout time (which isn't
 * tracked anywhere in the schema).
 */
async function runCheckoutConfirmationSweep(env) {
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Trigger prompts for checked-in bookings whose checkout date has arrived,
  //    for whichever party (host/guest) doesn't have a row yet.
  const dueBookings = await env.DB.prepare(`
    SELECT id, host_id, guest_id FROM bookings
    WHERE status = 'checked_in' AND date(check_out_date) <= date('now')
  `).all();

  for (const booking of dueBookings.results) {
    for (const party of ['host', 'guest']) {
      const existing = await env.DB.prepare(`SELECT id FROM checkout_confirmations WHERE booking_id = ? AND party = ?`)
        .bind(booking.id, party).first();
      if (!existing) {
        const id = crypto.randomUUID();
        await env.DB.prepare(`INSERT INTO checkout_confirmations (id, booking_id, party, triggered_at) VALUES (?, ?, ?, ?)`)
          .bind(id, booking.id, party, nowIso).run();
      }
    }
  }

  // 2. Mark unanswered prompts past their 2h grace window as no_response —
  //    silence stays neutral here too, same principle as presence confirmation.
  await env.DB.prepare(`
    UPDATE checkout_confirmations
    SET response = 'no_response', response_at = ?
    WHERE response IS NULL AND (julianday('now') - julianday(triggered_at)) >= (2.0 / 24.0)
  `).bind(nowIso).run();

  // 3. Finalize any booking where both parties have now responded (for real,
  //    or via no_response above). A report from either side sends the
  //    booking to human review as 'disputed'; otherwise it's 'completed'.
  const readyToFinalize = await env.DB.prepare(`
    SELECT b.id AS booking_id,
      MAX(CASE WHEN cc.party = 'host' THEN cc.response END) AS host_response,
      MAX(CASE WHEN cc.party = 'guest' THEN cc.response END) AS guest_response,
      COUNT(cc.id) AS row_count
    FROM bookings b
    JOIN checkout_confirmations cc ON cc.booking_id = b.id
    WHERE b.status = 'checked_in'
    GROUP BY b.id
    HAVING row_count = 2 AND host_response IS NOT NULL AND guest_response IS NOT NULL
  `).all();

  for (const row of readyToFinalize.results) {
    const eitherReportedIssue = row.host_response === 'report_issue' || row.guest_response === 'report_issue';

    if (eitherReportedIssue) {
      await env.DB.prepare(`UPDATE bookings SET status = 'disputed', updated_at = ? WHERE id = ?`)
        .bind(nowIso, row.booking_id).run();

      const bothReported = row.host_response === 'report_issue' && row.guest_response === 'report_issue';
      const flagId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO safety_flags (id, booking_id, raised_by, flag_type, description, status, created_at)
        VALUES (?, ?, 'system', 'checkout_dispute', ?, 'pending_review', ?)
      `).bind(
        flagId, row.booking_id,
        bothReported
          ? 'Both host and guest reported an issue at checkout — priority review.'
          : 'One party reported an issue at checkout.',
        nowIso
      ).run();
    } else {
      await env.DB.prepare(`UPDATE bookings SET status = 'completed', updated_at = ? WHERE id = ?`)
        .bind(nowIso, row.booking_id).run();
    }
  }
}

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

  // GET /api/admin/listings?status=pending_review — admin review queue
  if (pathname === '/api/admin/listings' && request.method === 'GET') {
    return adminListListings(request, env, url);
  }

  // POST /api/admin/listings/:id/approve or /reject
  const adminActionMatch = pathname.match(/^\/api\/admin\/listings\/([\w-]+)\/(approve|reject)$/);
  if (adminActionMatch && request.method === 'POST') {
    return adminReviewListing(request, env, adminActionMatch[1], adminActionMatch[2]);
  }

  // POST /api/admin/listings/:id/reactivate — un-pause a listing after review
  const adminReactivateMatch = pathname.match(/^\/api\/admin\/listings\/([\w-]+)\/reactivate$/);
  if (adminReactivateMatch && request.method === 'POST') {
    return adminReactivateListing(request, env, adminReactivateMatch[1]);
  }

  // POST /api/photos/upload — host uploads a listing photo to R2
  if (pathname === '/api/photos/upload' && request.method === 'POST') {
    return uploadPhoto(request, env);
  }

  // POST /api/auth/signup — create account with password
  if (pathname === '/api/auth/signup' && request.method === 'POST') {
    return authSignup(request, env);
  }

  // POST /api/auth/login
  if (pathname === '/api/auth/login' && request.method === 'POST') {
    return authLogin(request, env);
  }

  // POST /api/auth/logout
  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    return authLogout(request, env);
  }

  // GET /api/auth/me — current logged-in user's info
  if (pathname === '/api/auth/me' && request.method === 'GET') {
    return authMe(request, env);
  }

  // GET /api/users/me/listings — logged-in user's own listings, any status
  if (pathname === '/api/users/me/listings' && request.method === 'GET') {
    return myListings(request, env);
  }

  // GET /api/users/me/bookings — logged-in user's bookings, as guest and as host
  if (pathname === '/api/users/me/bookings' && request.method === 'GET') {
    return myBookings(request, env);
  }

  // GET /api/conversations — bookings the user is part of, with last message preview
  if (pathname === '/api/conversations' && request.method === 'GET') {
    return getConversations(request, env);
  }

  // GET /api/messages/:bookingId — full message thread for a booking
  const messagesMatch = pathname.match(/^\/api\/messages\/([\w-]+)$/);
  if (messagesMatch && request.method === 'GET') {
    return getMessages(request, env, messagesMatch[1]);
  }

  // POST /api/messages — send a message in a booking's conversation
  if (pathname === '/api/messages' && request.method === 'POST') {
    return sendMessage(request, env);
  }

  // POST /api/bookings/:id/accept or /decline — host responds to a booking request
  const bookingActionMatch = pathname.match(/^\/api\/bookings\/([\w-]+)\/(accept|decline)$/);
  if (bookingActionMatch && request.method === 'POST') {
    return respondToBooking(request, env, bookingActionMatch[1], bookingActionMatch[2]);
  }

  // GET /api/users/me/presence-pending — host's unanswered presence-confirmation prompts
  if (pathname === '/api/users/me/presence-pending' && request.method === 'GET') {
    return presencePending(request, env);
  }

  // POST /api/presence/:id/respond — host confirms "same as listed" or "changed"
  const presenceMatch = pathname.match(/^\/api\/presence\/([\w-]+)\/respond$/);
  if (presenceMatch && request.method === 'POST') {
    return respondPresence(request, env, presenceMatch[1]);
  }

  // GET /api/users/me/checkin-pending — guest's bookings needing check-in confirmation
  if (pathname === '/api/users/me/checkin-pending' && request.method === 'GET') {
    return checkinPending(request, env);
  }

  // POST /api/checkin/respond — guest confirms check-in went fine, or reports a mismatch
  if (pathname === '/api/checkin/respond' && request.method === 'POST') {
    return respondCheckin(request, env);
  }

  // GET /api/users/me/checkout-pending — logged-in user's unanswered checkout prompts
  if (pathname === '/api/users/me/checkout-pending' && request.method === 'GET') {
    return checkoutPending(request, env);
  }

  // POST /api/checkout/respond — host or guest confirms checkout, or reports an issue
  if (pathname === '/api/checkout/respond' && request.method === 'POST') {
    return respondCheckout(request, env);
  }

  // GET /api/notifications/summary — badge count of everything needing the user's attention
  if (pathname === '/api/notifications/summary' && request.method === 'GET') {
    return notificationsSummary(request, env);
  }

  // POST /api/users/me/profile-photo — save the URL of an already-uploaded photo to the profile
  if (pathname === '/api/users/me/profile-photo' && request.method === 'POST') {
    return updateProfilePhoto(request, env);
  }

  return json({ error: 'Not found' }, 404);
}

/**
 * Saves a profile photo URL to the logged-in user's record. The actual
 * upload happens via the existing /api/photos/upload endpoint (same
 * R2 bucket used for listing photos) — this just links the resulting
 * URL to the user, so no duplicate upload logic is needed.
 */
async function updateProfilePhoto(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { photo_url } = await request.json();
  if (!photo_url || typeof photo_url !== 'string') {
    return json({ error: 'A photo URL is required.' }, 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE users SET profile_photo_url = ?, updated_at = ? WHERE id = ?`)
    .bind(photo_url, now, user.id).run();

  return json({ profile_photo_url: photo_url });
}

/**
 * Aggregates every pending action item across the app into a single
 * count for the bell icon badge, plus the breakdown behind it. Reuses
 * the same underlying data as each page's own pending-fetch (booking
 * requests, presence/check-in/checkout confirmations, unread messages)
 * rather than tracking a separate notifications table — there's
 * nothing here that isn't already derivable from existing state.
 */
async function notificationsSummary(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const [bookingRequests, presence, checkin, checkout, unreadMessages] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE host_id = ? AND status = 'requested'`).bind(user.id).first(),
    env.DB.prepare(`
      SELECT COUNT(*) AS c FROM presence_confirmations pc JOIN bookings b ON pc.booking_id = b.id
      WHERE b.host_id = ? AND pc.host_response IS NULL
    `).bind(user.id).first(),
    env.DB.prepare(`
      SELECT COUNT(*) AS c FROM bookings b
      WHERE b.guest_id = ? AND b.status IN ('confirmed', 'presence_confirmed') AND date(b.check_in_date) <= date('now')
        AND NOT EXISTS (SELECT 1 FROM checkin_confirmations cc WHERE cc.booking_id = b.id)
    `).bind(user.id).first(),
    env.DB.prepare(`
      SELECT COUNT(*) AS c FROM checkout_confirmations cc JOIN bookings b ON cc.booking_id = b.id
      WHERE cc.response IS NULL AND ((cc.party = 'host' AND b.host_id = ?) OR (cc.party = 'guest' AND b.guest_id = ?))
    `).bind(user.id, user.id).first(),
    env.DB.prepare(`
      SELECT COUNT(*) AS c FROM messages m JOIN bookings b ON m.booking_id = b.id
      WHERE m.sender_id != ? AND m.read_at IS NULL AND (b.guest_id = ? OR b.host_id = ?)
    `).bind(user.id, user.id, user.id).first(),
  ]);

  const breakdown = {
    booking_requests: bookingRequests.c,
    presence_pending: presence.c,
    checkin_pending: checkin.c,
    checkout_pending: checkout.c,
    unread_messages: unreadMessages.c,
  };
  const total = Object.values(breakdown).reduce((sum, n) => sum + n, 0);

  return json({ total, ...breakdown });
}

/**
 * Returns pending checkout prompts for the logged-in user, whichever
 * role (host or guest) they hold on each booking. Never includes the
 * other party's response — this endpoint only ever looks up the
 * caller's own row, so there's nothing to leak even by omission.
 */
async function checkoutPending(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { results } = await env.DB.prepare(`
    SELECT cc.id AS checkout_id, cc.booking_id, cc.party, l.title AS listing_title, b.check_out_date
    FROM checkout_confirmations cc
    JOIN bookings b ON cc.booking_id = b.id
    JOIN listings l ON b.listing_id = l.id
    WHERE cc.response IS NULL
      AND ((cc.party = 'host' AND b.host_id = ?) OR (cc.party = 'guest' AND b.guest_id = ?))
    ORDER BY b.check_out_date ASC
  `).bind(user.id, user.id).all();

  return json({ pending: results });
}

async function respondCheckout(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { checkout_id, response } = await request.json();
  if (!checkout_id || !['all_good', 'report_issue'].includes(response)) {
    return json({ error: 'Invalid checkout response.' }, 400);
  }

  const row = await env.DB.prepare(`
    SELECT cc.*, b.host_id, b.guest_id FROM checkout_confirmations cc
    JOIN bookings b ON cc.booking_id = b.id
    WHERE cc.id = ?
  `).bind(checkout_id).first();

  if (!row) return json({ error: 'Not found.' }, 404);
  const expectedUserId = row.party === 'host' ? row.host_id : row.guest_id;
  if (expectedUserId !== user.id) return json({ error: 'Not authorized.' }, 403);
  if (row.response !== null) return json({ error: 'Already responded.' }, 409);

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE checkout_confirmations SET response = ?, response_at = ? WHERE id = ?`)
    .bind(response, now, checkout_id).run();

  return json({ checkout_id, response });
}

async function checkinPending(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { results } = await env.DB.prepare(`
    SELECT b.id AS booking_id, b.check_in_date, b.check_out_date, l.title AS listing_title
    FROM bookings b
    JOIN listings l ON b.listing_id = l.id
    WHERE b.guest_id = ?
      AND b.status IN ('confirmed', 'presence_confirmed')
      AND date(b.check_in_date) <= date('now')
      AND NOT EXISTS (SELECT 1 FROM checkin_confirmations cc WHERE cc.booking_id = b.id)
    ORDER BY b.check_in_date ASC
  `).bind(user.id).all();

  return json({ pending: results });
}

/**
 * Guest confirms check-in went fine, or reports the household doesn't
 * match what was listed. A 'no' response is treated as a real safety
 * event per the flow spec: it always flags the booking + pauses the
 * listing pending host/admin review, and issues a full refund note —
 * the frontend is responsible for showing real emergency numbers
 * BEFORE this ever gets called, this endpoint just records the outcome.
 */
async function respondCheckin(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { booking_id, response } = await request.json();
  if (!booking_id || !['yes', 'no'].includes(response)) {
    return json({ error: 'Invalid check-in response.' }, 400);
  }

  const booking = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(booking_id).first();
  if (!booking || booking.guest_id !== user.id) return json({ error: 'Booking not found.' }, 404);

  const existing = await env.DB.prepare(`SELECT id FROM checkin_confirmations WHERE booking_id = ?`).bind(booking_id).first();
  if (existing) return json({ error: 'Already responded.' }, 409);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO checkin_confirmations (id, booking_id, checked_in_at, household_match_response, response_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, booking_id, now, response, now).run();

  if (response === 'no') {
    await env.DB.prepare(`UPDATE bookings SET status = 'flagged', updated_at = ? WHERE id = ?`).bind(now, booking_id).run();
    await env.DB.prepare(`UPDATE listings SET status = 'paused', updated_at = ? WHERE id = ?`).bind(now, booking.listing_id).run();

    const flagId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO safety_flags (id, booking_id, raised_by, flag_type, description, status, created_at)
      VALUES (?, ?, 'guest', 'checkin_mismatch', 'Guest reported the household or space does not match what was listed at check-in. Full refund applies pending review.', 'pending_review', ?)
    `).bind(flagId, booking_id, now).run();
  } else {
    await env.DB.prepare(`UPDATE bookings SET status = 'checked_in', updated_at = ? WHERE id = ?`).bind(now, booking_id).run();
  }

  return json({ booking_id, response });
}

async function presencePending(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { results } = await env.DB.prepare(`
    SELECT pc.id AS presence_id, pc.booking_id, pc.cycle_number, pc.deadline_at,
           l.title AS listing_title, b.check_in_date, b.check_out_date
    FROM presence_confirmations pc
    JOIN bookings b ON pc.booking_id = b.id
    JOIN listings l ON b.listing_id = l.id
    WHERE b.host_id = ? AND pc.host_response IS NULL
    ORDER BY pc.deadline_at ASC
  `).bind(user.id).all();

  return json({ pending: results });
}

/**
 * Host confirms whether the household is "same as listed" or "changed"
 * for a specific booking. A "changed" response doesn't try to guess
 * whether the new state still satisfies the gender-matching rule — it
 * always routes to human review via safety_flags, since a live gender
 * mismatch is exactly the scenario this platform's core safety rule
 * exists to prevent.
 */
async function respondPresence(request, env, presenceId) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { response } = await request.json();
  if (!['same_as_listed', 'changed'].includes(response)) {
    return json({ error: 'Invalid response.' }, 400);
  }

  const row = await env.DB.prepare(`
    SELECT pc.*, b.host_id, b.id AS booking_id FROM presence_confirmations pc
    JOIN bookings b ON pc.booking_id = b.id
    WHERE pc.id = ?
  `).bind(presenceId).first();

  if (!row) return json({ error: 'Not found.' }, 404);
  if (row.host_id !== user.id) return json({ error: 'Not authorized.' }, 403);
  if (row.host_response !== null) return json({ error: 'Already responded.' }, 409);

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE presence_confirmations SET host_response = ?, response_at = ? WHERE id = ?`)
    .bind(response, now, presenceId).run();

  if (response === 'changed') {
    await env.DB.prepare(`UPDATE presence_confirmations SET resulted_in_flag = 1 WHERE id = ?`).bind(presenceId).run();
    await env.DB.prepare(`UPDATE bookings SET status = 'flagged', updated_at = ? WHERE id = ?`).bind(now, row.booking_id).run();

    const flagId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO safety_flags (id, booking_id, raised_by, flag_type, description, status, created_at)
      VALUES (?, ?, 'host', 'presence_mismatch', 'Host reported household presence has changed from what was listed.', 'pending_review', ?)
    `).bind(flagId, row.booking_id, now).run();
  } else {
    await env.DB.prepare(`UPDATE bookings SET status = 'presence_confirmed', updated_at = ? WHERE id = ? AND status IN ('confirmed', 'presence_confirmed')`)
      .bind(now, row.booking_id).run();
  }

  return json({ id: presenceId, response });
}

/**
 * Host accepts or declines a 'requested' booking. Only the host on
 * that specific booking can act on it — this is the missing link
 * between a guest's booking request and everything downstream
 * (presence confirmation, check-in, etc.), which previously had no
 * way to ever actually happen since bookings just sat at 'requested'.
 */
async function respondToBooking(request, env, bookingId, action) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const booking = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!booking) return json({ error: 'Booking not found.' }, 404);
  if (booking.host_id !== user.id) return json({ error: 'Only the host can respond to this booking.' }, 403);
  if (booking.status !== 'requested') return json({ error: 'This booking has already been responded to.' }, 409);

  const newStatus = action === 'accept' ? 'confirmed' : 'cancelled';
  const now = new Date().toISOString();

  await env.DB.prepare(`UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(newStatus, now, bookingId).run();

  return json({ id: bookingId, status: newStatus });
}

/**
 * Confirms the logged-in user is either the guest or host on a given
 * booking before letting them read or send messages tied to it —
 * chat is scoped to bookings, so this is the access-control checkpoint
 * for every messaging endpoint below.
 */
async function getBookingIfParticipant(env, bookingId, userId) {
  const booking = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!booking) return null;
  if (booking.guest_id !== userId && booking.host_id !== userId) return null;
  return booking;
}

async function getConversations(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { results } = await env.DB.prepare(`
    SELECT
      b.id AS booking_id, b.check_in_date, b.check_out_date, b.status,
      l.title AS listing_title,
      CASE WHEN b.guest_id = ? THEN host.full_name ELSE guest.full_name END AS other_party_name,
      (SELECT body FROM messages WHERE booking_id = b.id ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE booking_id = b.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
      (SELECT COUNT(*) FROM messages WHERE booking_id = b.id AND sender_id != ? AND read_at IS NULL) AS unread_count
    FROM bookings b
    JOIN listings l ON b.listing_id = l.id
    JOIN users guest ON b.guest_id = guest.id
    JOIN users host ON b.host_id = host.id
    WHERE b.guest_id = ? OR b.host_id = ?
    ORDER BY last_message_at DESC, b.created_at DESC
  `).bind(user.id, user.id, user.id, user.id).all();

  return json({ conversations: results });
}

async function getMessages(request, env, bookingId) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const booking = await getBookingIfParticipant(env, bookingId, user.id);
  if (!booking) return json({ error: 'Conversation not found.' }, 404);

  const { results } = await env.DB.prepare(`
    SELECT m.*, u.full_name AS sender_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.booking_id = ? ORDER BY m.created_at ASC
  `).bind(bookingId).all();

  // Mark the other party's messages as read now that this user has opened the thread
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE messages SET read_at = ? WHERE booking_id = ? AND sender_id != ? AND read_at IS NULL`)
    .bind(now, bookingId, user.id).run();

  return json({ messages: results, booking });
}

async function sendMessage(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { booking_id, body: messageBody } = await request.json();
  if (!booking_id || !messageBody || !messageBody.trim()) {
    return json({ error: 'A message body is required.' }, 400);
  }

  const booking = await getBookingIfParticipant(env, booking_id, user.id);
  if (!booking) return json({ error: 'Conversation not found.' }, 404);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(`INSERT INTO messages (id, booking_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, booking_id, user.id, messageBody.trim(), now).run();

  return json({ id, created_at: now }, 201);
}

async function myBookings(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const asGuest = await env.DB.prepare(`
    SELECT b.*, l.title, l.city, l.area, l.tier, l.photos
    FROM bookings b JOIN listings l ON b.listing_id = l.id
    WHERE b.guest_id = ? ORDER BY b.created_at DESC
  `).bind(user.id).all();

  const asHost = await env.DB.prepare(`
    SELECT b.*, l.title, l.city, l.area, l.tier, l.photos
    FROM bookings b JOIN listings l ON b.listing_id = l.id
    WHERE b.host_id = ? ORDER BY b.created_at DESC
  `).bind(user.id).all();

  return json({ as_guest: asGuest.results, as_host: asHost.results });
}

async function authMe(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  // Never send password_hash back to the client
  const { password_hash, ...safeUser } = user;
  return json({ user: safeUser });
}

async function myListings(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in.' }, 401);

  const { results } = await env.DB.prepare(`SELECT * FROM listings WHERE host_id = ? ORDER BY created_at DESC`).bind(user.id).all();
  return json({ listings: results });
}

/**
 * Password hashing using PBKDF2 via the Web Crypto API (built into
 * Workers — no external library needed). Each password gets its own
 * random salt; the stored value is "salt:hash" so verification can
 * re-derive with the same salt later.
 */
async function hashPassword(password, saltHex) {
  const encoder = new TextEncoder();
  const salt = saltHex
    ? new Uint8Array(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );

  const hashHex = [...new Uint8Array(derivedBits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const saltHexOut = [...salt].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${saltHexOut}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex] = stored.split(':');
  const recomputed = await hashPassword(password, saltHex);
  return recomputed === stored;
}

async function authSignup(request, env) {
  const { full_name, phone, gender, bank_account_number, bank_code, password } = await request.json();

  if (!full_name || !phone || !gender || !bank_account_number || !bank_code || !password) {
    return json({ error: 'All fields are required.' }, 400);
  }
  if (password.length < 8) {
    return json({ error: 'Password must be at least 8 characters.' }, 400);
  }

  const existingPhone = await env.DB.prepare(`SELECT id, password_hash FROM users WHERE phone = ?`).bind(phone).first();
  if (existingPhone && existingPhone.password_hash) {
    return json({ error: 'An account with this phone number already exists. Try logging in instead.' }, 409);
  }

  const existingBank = await env.DB.prepare(`SELECT id FROM users WHERE bank_account_number = ? AND phone != ?`).bind(bank_account_number, phone).first();
  if (existingBank) {
    return json({ error: 'This bank account is already linked to a Rentshare account.' }, 409);
  }

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  let userId;

  if (existingPhone) {
    // Legacy account created via "List your space" before login existed —
    // add a password to it rather than creating a duplicate.
    userId = existingPhone.id;
    await env.DB.prepare(`UPDATE users SET password_hash = ?, full_name = ?, gender = ?, bank_account_number = ?, bank_code = ?, updated_at = ? WHERE id = ?`)
      .bind(passwordHash, full_name, gender, bank_account_number, bank_code, now, userId).run();
  } else {
    userId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO users (id, full_name, phone, gender, bank_account_number, bank_code, password_hash, verification_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)
    `).bind(userId, full_name, phone, gender, bank_account_number, bank_code, passwordHash, now, now).run();
  }

  const sessionToken = await createSession(env, userId);
  return json({ session_token: sessionToken, user_id: userId }, 201);
}

async function authLogin(request, env) {
  const { phone, password } = await request.json();
  if (!phone || !password) return json({ error: 'Phone and password are required.' }, 400);

  const user = await env.DB.prepare(`SELECT id, password_hash, is_banned FROM users WHERE phone = ?`).bind(phone).first();
  if (!user || !user.password_hash) {
    return json({ error: 'Incorrect phone number or password.' }, 401);
  }
  if (user.is_banned) {
    return json({ error: 'This account has been suspended.' }, 403);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return json({ error: 'Incorrect phone number or password.' }, 401);
  }

  const sessionToken = await createSession(env, user.id);
  return json({ session_token: sessionToken, user_id: user.id });
}

async function authLogout(request, env) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(token).run();
  }
  return json({ success: true });
}

async function createSession(env, userId) {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await env.DB.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(sessionId, userId, now.toISOString(), expires.toISOString()).run();

  return sessionId;
}

/**
 * Validates a session token from the Authorization header and returns
 * the associated user, or null. Used to gate actions that now require
 * login (e.g. listing on behalf of a phone number that already has a
 * password set).
 */
async function getSessionUser(request, env) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return null;

  const session = await env.DB.prepare(`SELECT user_id, expires_at FROM sessions WHERE id = ?`).bind(token).first();
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) return null;

  return env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(session.user_id).first();
}

/**
 * Accepts a single image file (multipart/form-data, field name "photo"),
 * stores it in the R2 bucket, and returns a key + servable URL. Photos
 * are stored as R2 objects, not in the database — the listings.photos
 * column just holds a JSON array of these keys/URLs.
 */
async function uploadPhoto(request, env) {
  const formData = await request.formData();
  const file = formData.get('photo');

  if (!file || typeof file === 'string') {
    return json({ error: 'No photo file provided.' }, 400);
  }
  if (!file.type || !file.type.startsWith('image/')) {
    return json({ error: 'Only image files are allowed.' }, 400);
  }
  if (file.size > 8 * 1024 * 1024) {
    return json({ error: 'Photo must be under 8MB.' }, 400);
  }

  const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop() : 'jpg';
  const key = `listings/${crypto.randomUUID()}.${ext}`;

  await env.PHOTOS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  return json({ key, url: `/photos/${key}` }, 201);
}

/**
 * Serves an uploaded photo back out of R2. Public — anyone with the
 * URL can view it, same as any normal image on a website.
 */
async function servePhoto(env, key) {
  const object = await env.PHOTOS.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(object.body, { headers });
}

/**
 * Simple shared-password admin check. Not real authentication — good
 * enough for solo/single-admin use right now. Requires ADMIN_PASSWORD
 * as a Worker secret (wrangler secret put ADMIN_PASSWORD). Replace
 * with real per-user auth once more than one person needs admin access.
 */
function checkAdminAuth(request, env) {
  const password = request.headers.get('X-Admin-Password');
  return password && password === env.ADMIN_PASSWORD;
}

async function adminListListings(request, env, url) {
  if (!checkAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const status = url.searchParams.get('status') || 'pending_review';
  const { results } = await env.DB.prepare(`
    SELECT l.*,
      (SELECT sf.description FROM safety_flags sf
       JOIN bookings b ON sf.booking_id = b.id
       WHERE b.listing_id = l.id AND sf.status = 'pending_review'
       ORDER BY sf.created_at DESC LIMIT 1) AS flag_reason
    FROM listings l WHERE l.status = ? ORDER BY l.created_at ASC
  `).bind(status).all();
  return json({ listings: results });
}

async function adminReviewListing(request, env, id, action) {
  if (!checkAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const newStatus = action === 'approve' ? 'active' : 'removed';
  const now = new Date().toISOString();

  const result = await env.DB.prepare(`UPDATE listings SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending_review'`)
    .bind(newStatus, now, id).run();

  if (result.meta.changes === 0) {
    return json({ error: 'Listing not found or already reviewed.' }, 404);
  }

  return json({ id, status: newStatus });
}

/**
 * Reactivates a listing that was auto-paused after a guest reported a
 * check-in mismatch. This was a real gap: the check-in flow could pause
 * a listing but nothing could ever bring it back to active — this is
 * that missing path back.
 */
async function adminReactivateListing(request, env, id) {
  if (!checkAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE listings SET status = 'active', updated_at = ? WHERE id = ? AND status = 'paused'`)
    .bind(now, id).run();

  if (result.meta.changes === 0) {
    return json({ error: 'Listing not found or not currently paused.' }, 404);
  }

  return json({ id, status: 'active' });
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
 * Creates a booking. Guest is derived from the logged-in session, NOT
 * a client-supplied guest_id — trusting a client-supplied ID would let
 * anyone book under someone else's identity. Also computes real
 * pricing (nights × rate, minus platform commission) instead of the
 * earlier placeholder zeros.
 *
 * TODO: wire up actual Paystack payment initialization here — this
 * still just records the booking, it doesn't charge or hold funds yet.
 */
async function createBooking(request, env) {
  const guest = await getSessionUser(request, env);
  if (!guest) return json({ error: 'Please log in to book a stay.' }, 401);

  const body = await request.json();
  const { listing_id, check_in_date, check_out_date, check_in_time, room_share_consent } = body;

  if (!listing_id || !check_in_date || !check_out_date) {
    return json({ error: 'Missing booking details.' }, 400);
  }

  const listing = await env.DB.prepare(`SELECT * FROM listings WHERE id = ?`).bind(listing_id).first();
  if (!listing || listing.status !== 'active') return json({ error: 'Listing not found or not available.' }, 404);

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

  const checkIn = new Date(check_in_date);
  const checkOut = new Date(check_out_date);
  const nights = Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24));
  if (nights < 1) return json({ error: 'Check-out must be after check-in.' }, 400);
  if (listing.max_stay_nights && nights > listing.max_stay_nights) {
    return json({ error: `This listing allows a maximum stay of ${listing.max_stay_nights} nights.` }, 400);
  }

  const amountTotal = listing.price_per_night * nights;
  const platformCommission = Math.round(amountTotal * 0.12); // 12% commission, per the earlier pricing decision
  const hostPayoutAmount = amountTotal - platformCommission;

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
    id, listing_id, guest.id, listing.host_id, check_in_date, check_out_date,
    check_in_time || '14:00', guest.gender, isSameDay ? 1 : 0,
    amountTotal, platformCommission, hostPayoutAmount,
    listing.tier === 'shared_room_with_host' ? 1 : null,
    listing.tier === 'shared_room_with_host' ? now : null,
    now, now
  ).run();

  return json({ booking_id: id, status: 'requested', amount_total: amountTotal, nights }, 201);
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
    allows_visitors, allows_extra_guests, allows_parties, quiet_hours_enabled, quiet_hours,
    photos,
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

  if (host && host.password_hash) {
    // This phone number has a real account with a password now — no
    // longer safe to let anyone type the number in and list on their
    // behalf. Require a valid session matching this exact user.
    const sessionUser = await getSessionUser(request, env);
    if (!sessionUser || sessionUser.id !== host.id) {
      return json({ error: 'This phone number has an account. Please log in to list a space.' }, 401);
    }
  }

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
      allows_smoking, allows_pets, allows_alcohol,
      allows_visitors, allows_extra_guests, allows_parties, quiet_hours_enabled, quiet_hours,
      photos, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
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
    allows_visitors ? 1 : 0,
    allows_extra_guests ? 1 : 0,
    allows_parties ? 1 : 0,
    quiet_hours_enabled ? 1 : 0,
    quiet_hours_enabled ? (quiet_hours || null) : null,
    photos ? JSON.stringify(photos) : null,
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
  const { status: match_status, score: match_score } = compareNames(resolvedName, full_name);

  return json({
    resolved_name: resolvedName,
    match_status,
    match_score,
  });
}

/**
 * Real fuzzy name matching, replacing the earlier naive token-overlap
 * check. Combines two signals and takes the best of the two:
 *   1. Jaro-Winkler similarity on the full normalized name (catches
 *      typos, transposed letters, minor spelling differences).
 *   2. Best-alignment token matching (each name split into words,
 *      each word matched to its closest counterpart in the other
 *      name) — this is what actually handles the common real-world
 *      case here: Nigerian bank accounts are often registered with a
 *      different word order or an extra middle name than what's on
 *      an ID or a signup form, which a plain full-string comparison
 *      would wrongly penalize.
 * Three outcomes instead of the old binary matched/not-matched:
 * 'matched' (high confidence, no human needed), 'needs_review' (real
 * name overlap but not confident enough to auto-clear), 'flagged'
 * (looks like a genuine mismatch). Thresholds are a starting point —
 * worth tuning once there's real match data to look at.
 */
function compareNames(a, b) {
  const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const nameA = normalize(a);
  const nameB = normalize(b);

  if (!nameA || !nameB) return { status: 'flagged', score: 0 };

  const fullNameScore = jaroWinkler(nameA, nameB);

  const tokensA = nameA.split(' ').filter(Boolean);
  const tokensB = nameB.split(' ').filter(Boolean);
  const tokenScore = bestTokenAlignmentScore(tokensA, tokensB);

  const combined = Math.max(fullNameScore, tokenScore);
  const score = Math.round(combined * 100) / 100;

  let status;
  if (combined >= 0.88) status = 'matched';
  else if (combined >= 0.7) status = 'needs_review';
  else status = 'flagged';

  return { status, score };
}

/**
 * For each word in the shorter name, finds its best Jaro-Winkler match
 * among the words in the longer name, then averages those best
 * matches. This is what lets "John Adebayo Okafor" and "Okafor John A"
 * score highly despite being in a completely different order.
 */
function bestTokenAlignmentScore(tokensA, tokensB) {
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  if (shorter.length === 0 || longer.length === 0) return 0;

  let total = 0;
  for (const token of shorter) {
    let best = 0;
    for (const other of longer) {
      const s = jaroWinkler(token, other);
      if (s > best) best = s;
    }
    total += best;
  }
  return total / shorter.length;
}

/** Standard Jaro similarity between two strings, 0 to 1. */
function jaroSimilarity(s1, s2) {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
}

/** Jaro-Winkler: Jaro similarity boosted for strings sharing a common prefix. */
function jaroWinkler(s1, s2, prefixWeight = 0.1) {
  const jaro = jaroSimilarity(s1, s2);
  let prefixLen = 0;
  const maxPrefix = 4;
  for (let i = 0; i < Math.min(maxPrefix, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }
  return jaro + prefixLen * prefixWeight * (1 - jaro);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
