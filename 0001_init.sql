-- Rentshare — D1 (SQLite) schema, v1
-- Converted from the Postgres design in rentshare-database-schema.md
-- Run with: wrangler d1 migrations apply rentshare-db

PRAGMA foreign_keys = ON;

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id                    TEXT PRIMARY KEY,                 -- generate with crypto.randomUUID() in Worker code
  full_name             TEXT NOT NULL,
  phone                 TEXT NOT NULL UNIQUE,
  email                 TEXT UNIQUE,
  gender                TEXT NOT NULL CHECK (gender IN ('female','male')),

  bank_account_number   TEXT NOT NULL UNIQUE,
  bank_code             TEXT NOT NULL,
  bank_resolved_name    TEXT,
  name_match_status     TEXT NOT NULL DEFAULT 'pending'
                          CHECK (name_match_status IN ('pending','matched','flagged','manual_review')),

  id_document_type      TEXT CHECK (id_document_type IN ('nin','passport','drivers_license')),
  id_document_name      TEXT,
  id_verified_at        TEXT,                              -- ISO8601 timestamp

  verification_status   TEXT NOT NULL DEFAULT 'unverified'
                          CHECK (verification_status IN ('unverified','bank_verified','id_verified','fully_verified')),

  is_banned             INTEGER NOT NULL DEFAULT 0,         -- 0/1
  non_response_count    INTEGER NOT NULL DEFAULT 0,
  non_response_flagged  INTEGER NOT NULL DEFAULT 0,

  -- Lifestyle disclosure — personal habits, shown to the other party for
  -- Shared Space / Shared Room tiers specifically (proximity matters there).
  -- Informational only, not enforced — the guest decides what they're comfortable with.
  smokes                TEXT CHECK (smokes IN ('yes','no','outside_only')),
  drinks_alcohol        TEXT CHECK (drinks_alcohol IN ('yes','no','socially')),
  has_pet               INTEGER,                            -- 0/1, nullable if not disclosed

  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_users_phone ON users (phone);

-- ============================================================
-- LISTINGS
-- ============================================================
CREATE TABLE listings (
  id                     TEXT PRIMARY KEY,
  host_id                TEXT NOT NULL REFERENCES users(id),
  tier                   TEXT NOT NULL CHECK (tier IN ('private_room','shared_space','shared_room_with_host')),

  title                  TEXT NOT NULL,
  description            TEXT,
  city                   TEXT NOT NULL,
  area                   TEXT NOT NULL,
  address                TEXT NOT NULL,
  price_per_night        REAL NOT NULL,

  gender_allocation      TEXT CHECK (gender_allocation IN ('female_only','male_only')),
  lockable_door          INTEGER,
  shared_with_household  INTEGER,
  household_size         INTEGER,
  household_gender_note  TEXT CHECK (household_gender_note IN ('all_women','all_men','mixed')),
  sleeping_arrangement   TEXT,
  bathroom_access        TEXT CHECK (bathroom_access IN ('shared','private')),
  access_hours           TEXT CHECK (access_hours IN ('24h','curfew')),
  curfew_time            TEXT,                              -- HH:MM
  belongings_storage     TEXT CHECK (belongings_storage IN ('lockable','guest_keeps')),
  kitchen_access         TEXT CHECK (kitchen_access IN ('shared_included','not_accessible')),
  max_stay_nights        INTEGER,
  cancellation_policy    TEXT CHECK (cancellation_policy IN ('flexible','moderate')),

  -- House rules — apply to every tier, enforced as booking-time expectations
  -- (a guest agrees to these when booking; violations are handled like any
  -- other disclosure mismatch via safety_flags).
  allows_smoking          INTEGER,   -- 0/1
  allows_pets             INTEGER,
  allows_alcohol          INTEGER,

  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','paused','removed','pending_review')),

  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CHECK (tier = 'private_room' OR gender_allocation IS NOT NULL)
);

CREATE INDEX idx_listings_search ON listings (city, area, tier, gender_allocation, status);
CREATE INDEX idx_listings_host ON listings (host_id);

-- ============================================================
-- BOOKINGS
-- ============================================================
CREATE TABLE bookings (
  id                    TEXT PRIMARY KEY,
  listing_id            TEXT NOT NULL REFERENCES listings(id),
  guest_id              TEXT NOT NULL REFERENCES users(id),
  host_id               TEXT NOT NULL REFERENCES users(id),

  check_in_date         TEXT NOT NULL,                      -- YYYY-MM-DD
  check_out_date        TEXT NOT NULL,
  check_in_time         TEXT NOT NULL,                       -- HH:MM

  guest_gender_snapshot TEXT NOT NULL,
  is_same_day_booking   INTEGER NOT NULL DEFAULT 0,

  status                TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
                           'requested','confirmed','presence_confirmed','presence_unconfirmed',
                           'checked_in','completed','flagged','disputed','cancelled'
                         )),

  amount_total          REAL NOT NULL,
  platform_commission   REAL NOT NULL,
  host_payout_amount    REAL NOT NULL,
  payment_reference     TEXT,
  payment_status        TEXT NOT NULL DEFAULT 'pending'
                           CHECK (payment_status IN ('pending','held','released','refunded')),

  -- Only relevant when the booked listing's tier = 'shared_room_with_host' (Step A''' in the flow spec)
  room_share_consent    INTEGER,        -- must be 1 before booking can move past 'requested' for this tier
  room_share_consent_at TEXT,

  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_bookings_guest ON bookings (guest_id);
CREATE INDEX idx_bookings_host ON bookings (host_id);
CREATE INDEX idx_bookings_status ON bookings (status);
CREATE INDEX idx_bookings_listing ON bookings (listing_id);

-- ============================================================
-- PRESENCE CONFIRMATIONS (Step C / Step E)
-- ============================================================
CREATE TABLE presence_confirmations (
  id                TEXT PRIMARY KEY,
  booking_id        TEXT NOT NULL REFERENCES bookings(id),
  cycle_number      INTEGER NOT NULL DEFAULT 1,
  triggered_at      TEXT NOT NULL,
  deadline_at       TEXT NOT NULL,
  host_response     TEXT CHECK (host_response IN ('same_as_listed','changed','no_response')),
  response_at       TEXT,
  resulted_in_flag  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_presence_booking ON presence_confirmations (booking_id);

-- ============================================================
-- CHECK-IN CONFIRMATIONS (Step D)
-- ============================================================
CREATE TABLE checkin_confirmations (
  id                        TEXT PRIMARY KEY,
  booking_id                TEXT NOT NULL REFERENCES bookings(id),
  checked_in_at             TEXT NOT NULL,
  household_match_response  TEXT CHECK (household_match_response IN ('yes','no','no_response')),
  response_at               TEXT
);

CREATE INDEX idx_checkin_booking ON checkin_confirmations (booking_id);

-- ============================================================
-- CHECKOUT CONFIRMATIONS (Step G host / Step G' guest)
-- ============================================================
CREATE TABLE checkout_confirmations (
  id             TEXT PRIMARY KEY,
  booking_id     TEXT NOT NULL REFERENCES bookings(id),
  party          TEXT NOT NULL CHECK (party IN ('host','guest')),
  triggered_at   TEXT NOT NULL,
  response       TEXT CHECK (response IN ('all_good','report_issue','no_response')),
  response_at    TEXT,

  UNIQUE (booking_id, party)
);

CREATE INDEX idx_checkout_booking ON checkout_confirmations (booking_id);

-- ============================================================
-- SAFETY FLAGS (Step F + mismatches from C, D, G/G')
-- ============================================================
CREATE TABLE safety_flags (
  id               TEXT PRIMARY KEY,
  booking_id       TEXT NOT NULL REFERENCES bookings(id),
  raised_by        TEXT NOT NULL CHECK (raised_by IN ('host','guest','system')),
  flag_type        TEXT NOT NULL CHECK (flag_type IN (
                      'presence_mismatch','gender_mismatch','property_damage',
                      'missing_item','belongings_issue','other'
                    )),
  description      TEXT,
  photo_url        TEXT,
  status           TEXT NOT NULL DEFAULT 'pending_review'
                      CHECK (status IN ('pending_review','upheld','dismissed')),
  is_mutual        INTEGER NOT NULL DEFAULT 0,
  resolution_notes TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at      TEXT
);

CREATE INDEX idx_flags_pending ON safety_flags (status) WHERE status = 'pending_review';
CREATE INDEX idx_flags_booking ON safety_flags (booking_id);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  booking_id          TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  paystack_reference  TEXT NOT NULL,
  amount              REAL NOT NULL,
  platform_fee        REAL NOT NULL,
  host_share          REAL NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','held','released','refunded','disputed_hold')),
  released_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================
-- REVIEWS
-- ============================================================
CREATE TABLE reviews (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT NOT NULL REFERENCES bookings(id),
  reviewer_id            TEXT NOT NULL REFERENCES users(id),
  reviewee_id            TEXT NOT NULL REFERENCES users(id),
  rating                 INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  space_matched_listing  INTEGER,
  felt_safe              INTEGER,
  comment                TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_reviews_reviewee ON reviews (reviewee_id);
