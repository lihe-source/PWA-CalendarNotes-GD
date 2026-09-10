-- Additive, idempotent migration. Existing events, notes and sessions are preserved.
CREATE TABLE IF NOT EXISTS desktop_auth_requests (
 id TEXT PRIMARY KEY, state_hash TEXT NOT NULL UNIQUE, challenge TEXT NOT NULL,
 status TEXT NOT NULL, payload TEXT, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desktop_auth_expiry ON desktop_auth_requests(expires_at);
