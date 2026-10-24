import crypto from 'node:crypto';

export const SESSION_COOKIE = 'chore_quest_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CHILD_PIN_PATTERN = /^\d{4,8}$/;

export function validChildPin(pin) {
  return typeof pin === 'string' && CHILD_PIN_PATTERN.test(pin);
}

export function pinMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function hashPin(pin) {
  if (!validChildPin(pin)) throw new Error('PIN must be 4–8 digits.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPin(pin, salt, expectedHash) {
  if (!validChildPin(pin) || typeof salt !== 'string' || typeof expectedHash !== 'string') return false;
  try {
    const actual = crypto.scryptSync(pin, salt, 64);
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(db, role, childId = null, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  db.prepare(`INSERT INTO auth_sessions (token_hash, role, child_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)`).run(tokenHash(token), role, childId, now, expiresAt);
  return { token, expiresAt };
}

export function getSession(db, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const hash = tokenHash(token);
  const session = db.prepare(`SELECT role, child_id AS childId, expires_at AS expiresAt
    FROM auth_sessions WHERE token_hash = ? AND expires_at > ?`).get(hash, now);
  if (!session) db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  return session || null;
}

export function revokeSession(db, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return;
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(token));
}
