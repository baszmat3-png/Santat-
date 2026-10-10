-- SNTAT database schema (PostgreSQL). Safe to run more than once.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  invite_code   TEXT UNIQUE NOT NULL,
  referred_by   BIGINT REFERENCES users(id),
  banned        BOOLEAN NOT NULL DEFAULT FALSE,
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OTP codes (store only the hash, never the plain code)
CREATE TABLE IF NOT EXISTS otp_codes (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  payload    JSONB,                        -- pending signup data (name, password_hash)
  attempts   INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_email_idx ON otp_codes(email, created_at DESC);

-- One wallet per user: points as BIGINT, dollars as cents to avoid rounding errors
CREATE TABLE IF NOT EXISTS wallets (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  points        BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0),
  usd_cents     BIGINT NOT NULL DEFAULT 0 CHECK (usd_cents >= 0),
  counter_size  BIGINT NOT NULL DEFAULT 111000,
  last_bonus    DATE
);

-- 24h mining sessions (points are computed on the server from these times)
CREATE TABLE IF NOT EXISTS mining_sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at    TIMESTAMPTZ NOT NULL,
  size       BIGINT NOT NULL,              -- counter size when the session started
  credited   BIGINT NOT NULL DEFAULT 0,    -- points already added to the wallet
  active     BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS mining_user_idx ON mining_sessions(user_id, active);

-- Counter store catalogue
CREATE TABLE IF NOT EXISTS counter_items (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  add_size    BIGINT NOT NULL,
  price_points BIGINT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

-- P2P marketplace
CREATE TABLE IF NOT EXISTS p2p_listings (
  id         BIGSERIAL PRIMARY KEY,
  seller_id  BIGINT REFERENCES users(id),  -- NULL = official listing
  points     BIGINT NOT NULL CHECK (points > 0),
  price_cents BIGINT NOT NULL CHECK (price_cents > 0),
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','sold','cancelled')),
  buyer_id   BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sold_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS p2p_status_idx ON p2p_listings(status, created_at DESC);

-- Rooms
CREATE TABLE IF NOT EXISTS rooms (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   BIGINT REFERENCES users(id),  -- NULL = official room
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id   BIGINT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

-- Friends
CREATE TABLE IF NOT EXISTS friends (
  user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
  friend_id  BIGINT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

-- Transaction log (every change to points or dollars)
CREATE TABLE IF NOT EXISTS transactions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                -- mining, bonus, referral, convert, p2p_buy, p2p_sell, store
  points     BIGINT NOT NULL DEFAULT 0,
  usd_cents  BIGINT NOT NULL DEFAULT 0,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tx_user_idx ON transactions(user_id, created_at DESC);

-- App settings controlled from the admin panel (one row per key)
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

INSERT INTO config(key, value) VALUES
  ('daily_bonus',   '1000'),
  ('referral_bonus','2000'),
  ('points_per_usd','10000'),
  ('announcement',  '""'),
  ('maintenance',   'false')
ON CONFLICT (key) DO NOTHING;

INSERT INTO counter_items(name, add_size, price_points)
SELECT * FROM (VALUES
  ('عداد صغير',  25000,  20000),
  ('عداد متوسط', 100000, 70000),
  ('عداد كبير',  500000, 300000)
) v(name, add_size, price_points)
WHERE NOT EXISTS (SELECT 1 FROM counter_items);

INSERT INTO rooms(name)
SELECT * FROM (VALUES ('غرفة المبتدئين'),('غرفة النقاط الذهبية'),('غرفة المتداولين')) v(name)
WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE owner_id IS NULL);
