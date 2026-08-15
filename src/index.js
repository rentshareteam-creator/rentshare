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
  if (pathname === '
