// Rentshare — homepage interactivity.
// Fetches real listings from /api/listings once the D1 database has data.
// Falls back to placeholder cards if the API isn't wired up yet, so the
// page never looks broken during early development.

const state = { tier: '', area: '' };

const typeTabs = document.querySelectorAll('.type-tab');
const areaChips = document.querySelectorAll('.area-chip');
const listingsEl = document.getElementById('listings');

// Account icon + bottom nav reflect login state.
// Logged out: everything points to login.html.
// Logged in: account icon and Profile tab go to the real profile page.
// Bookings/Chats pages don't exist yet, so — while logged in — they
// point to profile.html too (closest real destination) rather than
// sending a logged-in user back to the login screen, which would be
// a confusing dead end. Swap these to their own real pages once built.
const accountBtn = document.getElementById('account-btn');
const bookingsTab = document.getElementById('bookings-tab');
const chatsTab = document.getElementById('chats-tab');
const profileTab = document.getElementById('profile-tab');
const sessionToken = localStorage.getItem('rentshare_session');

if (sessionToken) {
  if (accountBtn) {
    accountBtn.href = '/profile.html';
    accountBtn.style.color = 'var(--yellow-text)';
  }
  if (profileTab) profileTab.href = '/profile.html';
  if (bookingsTab) bookingsTab.href = '/profile.html';
  if (chatsTab) chatsTab.href = '/profile.html';
}

// Notification bell — links to login when signed out, same as account.
// Once signed in, there's no notifications page yet, so it's a
// placeholder tap rather than a dead link or a redirect to login.
const notifBtn = document.getElementById('notif-btn');
if (notifBtn && sessionToken) {
  notifBtn.removeAttribute('href');
  notifBtn.addEventListener('click', (e) => {
    e.preventDefault();
    alert('Notifications for new bookings and messages are coming soon.');
  });
}

typeTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    typeTabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.tier = tab.dataset.tier;
    loadListings();
  });
});

areaChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    areaChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.area = chip.dataset.area;
    loadListings();
  });
});

async function loadListings() {
  listingsEl.innerHTML = '<p class="loading-note">Loading listings…</p>';

  const params = new URLSearchParams();
  if (state.tier) params.set('tier', state.tier);
  if (state.area) params.set('city', state.area); // TODO: separate area filter once schema query supports it

  try {
    const res = await fetch(`/api/listings?${params.toString()}`);
    const data = await res.json();

    if (!data.listings || data.listings.length === 0) {
      listingsEl.innerHTML = '<p class="loading-note">No listings yet — check back soon.</p>';
      return;
    }

    listingsEl.innerHTML = data.listings.map(renderCard).join('');
  } catch (err) {
    // API not wired up yet (no D1 data during early dev) — show placeholders
    // instead of a broken-looking empty page.
    listingsEl.innerHTML = PLACEHOLDER_CARDS;
  }
}

function renderCard(listing) {
  const isShared = listing.tier !== 'private_room';
  const tierLabel = listing.tier === 'shared_room_with_host' ? 'Shared Room' : (isShared ? 'Shared Space' : 'Private Room');
  const genderLabel = listing.gender_allocation === 'female_only' ? 'Women only' : 'Men only';
  let photos = [];
  try { photos = listing.photos ? JSON.parse(listing.photos) : []; } catch (e) {}
  const thumbContent = photos[0] ? `<img src="${photos[0]}" alt="" style="width:100%;height:100%;object-fit:cover;">` : '';

  return `
    <div class="listing-card">
      <div class="listing-thumb">
        ${thumbContent}
        <div class="type-tag ${isShared ? 'shared' : ''}">${tierLabel}</div>
      </div>
      <div class="listing-info">
        <div class="listing-title">${escapeHtml(listing.title)}</div>
        <div class="listing-meta">${escapeHtml(listing.area)}, ${escapeHtml(listing.city)}</div>
        <div class="badge-row">
          ${isShared ? `<div class="mini-badge gender">${genderLabel}</div>` : ''}
          <div class="mini-badge">ID verified</div>
        </div>
        <div class="listing-price">₦${Number(listing.price_per_night).toLocaleString()} <span>/ night</span></div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const PLACEHOLDER_CARDS = `
  <div class="listing-card">
    <div class="listing-thumb"><div class="type-tag">Private Room</div></div>
    <div class="listing-info">
      <div class="listing-title">Cosy self-contained, Yaba</div>
      <div class="listing-meta">Yaba, Lagos</div>
      <div class="badge-row"><div class="mini-badge">ID verified</div></div>
      <div class="listing-price">₦18,000 <span>/ night</span></div>
    </div>
  </div>
  <div class="listing-card">
    <div class="listing-thumb"><div class="type-tag shared">Shared Space</div></div>
    <div class="listing-info">
      <div class="listing-title">Sitting room stay, Surulere</div>
      <div class="listing-meta">Surulere, Lagos</div>
      <div class="badge-row"><div class="mini-badge gender">Women only</div><div class="mini-badge">Verified</div></div>
      <div class="listing-price">₦7,000 <span>/ night</span></div>
    </div>
  </div>
`;

loadListings();
