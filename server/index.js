import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createDatabase, dashboardData, nextMemberId } from './db.js';
import { localDateKey, validQuantity } from './domain.js';
import { createPushSender, pushConfiguration } from './push.js';
import { isSafePushEndpoint } from './push-endpoint.js';
import {
  createSession, getSession, hashPin, pinMatches, revokeSession, SESSION_COOKIE,
  SESSION_TTL_MS, validChildPin, verifyPin
} from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../client/dist');
const childAvatars = ['🦊', '🐻', '🐼', '🐸', '🦄', '🐱', '🐶', '🐨', '🐧', '🐰'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_COOLDOWN_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function readSessionCookie(req) {
  const prefix = `${SESSION_COOKIE}=`;
  const raw = (req.get('cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!raw) return null;
  try { return decodeURIComponent(raw.slice(prefix.length)); } catch { return null; }
}

export function createApp({ db, adminPin = '2468', onCompletion = async () => {}, pushPublicKey = null, trustProxy = false, resolvePushHostname } = {}) {
  if (!db) throw new Error('createApp requires a database instance');
  const app = express();
  const router = express.Router();
  const dummyChildPin = hashPin('0000');

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  if (trustProxy) app.set('trust proxy', trustProxy === true ? 1 : trustProxy);

  // Use the TCP peer, not client-supplied forwarding headers, for PIN throttling.
  function clientIpHash(req) {
    return createHash('sha256').update(req.socket.remoteAddress || 'unknown').digest('hex');
  }
  function clearFailures(ipHash) {
    db.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').run(ipHash);
  }
  function loginIsBlocked(ipHash, now = Date.now()) {
    const record = db.prepare('SELECT window_started AS windowStarted, blocked_until AS blockedUntil FROM login_attempts WHERE ip_hash = ?').get(ipHash);
    if (!record) return 0;
    if (record.blockedUntil > now) return record.blockedUntil;
    if (record.blockedUntil || record.windowStarted < now - LOGIN_WINDOW_MS) clearFailures(ipHash);
    return 0;
  }
  function recordLoginFailure(ipHash, now = Date.now()) {
    db.transaction(() => {
      const record = db.prepare('SELECT window_started AS windowStarted, failures, blocked_until AS blockedUntil FROM login_attempts WHERE ip_hash = ?').get(ipHash);
      if (record?.blockedUntil > now) return;
      const inWindow = record && record.windowStarted >= now - LOGIN_WINDOW_MS;
      const windowStarted = inWindow ? record.windowStarted : now;
      const failures = (inWindow ? record.failures : 0) + 1;
      const blockedUntil = failures >= LOGIN_MAX_FAILURES ? now + LOGIN_COOLDOWN_MS : 0;
      db.prepare(`INSERT INTO login_attempts (ip_hash, window_started, failures, blocked_until)
        VALUES (?, ?, ?, ?) ON CONFLICT(ip_hash) DO UPDATE SET
        window_started = excluded.window_started, failures = excluded.failures, blocked_until = excluded.blocked_until`)
        .run(ipHash, windowStarted, blockedUntil ? 0 : failures, blockedUntil);
      db.prepare(`DELETE FROM login_attempts WHERE (blocked_until > 0 AND blocked_until <= ?)
        OR (blocked_until = 0 AND window_started < ?)`).run(now, now - LOGIN_WINDOW_MS);
    })();
  }
  function guardLogin(req, res) {
    const ipHash = clientIpHash(req);
    const blockedUntil = loginIsBlocked(ipHash);
    if (!blockedUntil) return ipHash;
    const seconds = Math.ceil((blockedUntil - Date.now()) / 1000);
    res.set('Retry-After', String(seconds));
    res.status(429).json({ error: 'Too many incorrect PIN attempts. Try again in 15 minutes.' });
    return null;
  }
  function setSessionCookie(req, res, role, childId = null) {
    const previous = readSessionCookie(req);
    if (previous) revokeSession(db, previous);
    const { token } = createSession(db, role, childId);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: Boolean(req.secure), path: '/', maxAge: SESSION_TTL_MS
    });
  }
  function sessionFromRequest(req) {
    return getSession(db, readSessionCookie(req));
  }
  function requireAuth(req, res, next) {
    const session = sessionFromRequest(req);
    if (!session) return res.status(401).json({ error: 'Sign in with a PIN to continue.' });
    if (session.role === 'child') {
      const child = db.prepare('SELECT id, name, avatar FROM children WHERE id = ?').get(session.childId);
      if (!child) {
        revokeSession(db, readSessionCookie(req));
        return res.status(401).json({ error: 'This child profile is no longer available. Sign in again.' });
      }
      req.auth = { role: 'child', childId: child.id, child };
    } else req.auth = { role: 'parent', childId: null, child: null };
    next();
  }
  function requireParent(req, res, next) {
    if (req.auth?.role !== 'parent') return res.status(403).json({ error: 'Parent sign-in required.' });
    next();
  }
  function publicAuth(session) {
    if (session.role === 'parent') return { role: 'parent' };
    const child = db.prepare('SELECT id, name, avatar FROM children WHERE id = ?').get(session.childId);
    return child ? { role: 'child', child } : null;
  }
  function loginResponse(req, res, role, childId = null) {
    setSessionCookie(req, res, role, childId);
    return role === 'parent' ? { role } : { role, child: db.prepare('SELECT id, name, avatar FROM children WHERE id = ?').get(childId) };
  }
  function childPinOwner(pin, exceptId = null) {
    let owner = null;
    const configured = db.prepare('SELECT id, pin_salt, pin_hash FROM children WHERE pin_hash IS NOT NULL AND pin_salt IS NOT NULL').all();
    for (const child of configured) {
      const matches = verifyPin(pin, child.pin_salt, child.pin_hash);
      if (matches && child.id !== exceptId) owner = child.id;
    }
    return owner;
  }
  function pinConflicts(pin, exceptId = null) {
    const isParentPin = pinMatches(pin, adminPin);
    const owner = childPinOwner(pin, exceptId);
    return isParentPin || owner !== null;
  }

  router.get('/health', (_req, res) => res.json({ ok: true }));
  router.post('/auth/child-login', (req, res) => {
    const ip = guardLogin(req, res);
    if (!ip) return;
    const pin = req.body?.pin;
    let match = null;
    if (validChildPin(pin)) {
      const children = db.prepare('SELECT id, pin_salt, pin_hash FROM children WHERE pin_hash IS NOT NULL AND pin_salt IS NOT NULL').all();
      for (const child of children) if (verifyPin(pin, child.pin_salt, child.pin_hash)) match = child;
      if (!children.length) verifyPin(pin, dummyChildPin.salt, dummyChildPin.hash);
    }
    if (!match) {
      recordLoginFailure(ip);
      return res.status(401).json({ error: 'That child PIN was not recognized. Ask a parent to set or reset it.' });
    }
    clearFailures(ip);
    const session = loginResponse(req, res, 'child', match.id);
    res.json(session);
  });
  router.post('/auth/parent-login', (req, res) => {
    const ip = guardLogin(req, res);
    if (!ip) return;
    if (!pinMatches(req.body?.pin, adminPin)) {
      recordLoginFailure(ip);
      return res.status(401).json({ error: 'That parent PIN was not recognized.' });
    }
    clearFailures(ip);
    res.json(loginResponse(req, res, 'parent'));
  });
  router.get('/auth/me', requireAuth, (req, res) => res.json(publicAuth(req.auth) || { role: 'parent' }));
  router.post('/auth/logout', (req, res) => {
    const token = readSessionCookie(req);
    if (token) revokeSession(db, token);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: Boolean(req.secure), path: '/' });
    res.json({ ok: true });
  });

  router.use(requireAuth);
  router.get('/data', (_req, res) => res.json(dashboardData(db)));
  router.get('/logs', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 30));
    const logs = db.prepare(`SELECT l.id, l.chore_id AS choreId, c.name AS choreName,
      l.member_id AS memberId, m.name AS memberName, m.avatar AS memberAvatar,
      l.quantity, l.completed_at AS completedAt, l.local_day AS localDay, c.unit, c.points
      FROM logs l JOIN chores c ON c.id = l.chore_id JOIN children m ON m.id = l.member_id
      ORDER BY l.completed_at DESC, l.id DESC LIMIT ?`).all(limit);
    res.json(logs);
  });
  router.get('/push/config', (_req, res) => res.json({ enabled: Boolean(pushPublicKey), publicKey: pushPublicKey }));
  router.post('/push/subscriptions', async (req, res) => {
    const requestedMemberId = req.body?.memberId === undefined ? null : Number(req.body.memberId);
    if (req.auth.role === 'child' && requestedMemberId !== null && requestedMemberId !== req.auth.childId) {
      return res.status(403).json({ error: 'You can only set alerts for your own profile.' });
    }
    const memberId = req.auth.role === 'child' ? req.auth.childId : requestedMemberId;
    const { subscription } = req.body || {};
    if (!Number.isInteger(memberId) || typeof subscription?.endpoint !== 'string' || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'A child profile and valid push subscription are required.' });
    }
    if (!await isSafePushEndpoint(subscription.endpoint, resolvePushHostname)) {
      return res.status(400).json({ error: 'Push endpoint must use HTTPS and resolve only to public addresses.' });
    }
    const member = db.prepare('SELECT id FROM children WHERE id = ?').get(memberId);
    if (!member) return res.status(404).json({ error: 'Child profile not found.' });
    db.prepare(`INSERT INTO push_subscriptions (member_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?) ON CONFLICT(member_id, endpoint) DO UPDATE SET
      p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(memberId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
    res.status(201).json({ ok: true });
  });
  router.delete('/push/subscriptions', (req, res) => {
    const endpoint = req.body?.endpoint;
    const requestedMemberId = req.body?.memberId === undefined ? null : Number(req.body.memberId);
    if (req.auth.role === 'child' && requestedMemberId !== null && requestedMemberId !== req.auth.childId) {
      return res.status(403).json({ error: 'You can only manage alerts for your own profile.' });
    }
    const memberId = req.auth.role === 'child' ? req.auth.childId : requestedMemberId;
    if (typeof endpoint !== 'string' || !Number.isInteger(memberId)) return res.status(400).json({ error: 'A child profile and subscription endpoint are required.' });
    db.prepare('DELETE FROM push_subscriptions WHERE member_id = ? AND endpoint = ?').run(memberId, endpoint);
    res.json({ ok: true });
  });

  router.post('/logs', (req, res, next) => {
    try {
      const choreId = Number(req.body?.choreId);
      const requestedMemberId = req.body?.memberId === undefined ? null : Number(req.body.memberId);
      if (req.auth.role === 'child' && requestedMemberId !== null && requestedMemberId !== req.auth.childId) {
        return res.status(403).json({ error: 'You can only log chores as yourself.' });
      }
      const memberId = req.auth.role === 'child' ? req.auth.childId : requestedMemberId;
      const quantity = Number(req.body?.quantity ?? 1);
      if (!Number.isInteger(choreId) || !Number.isInteger(memberId) || !validQuantity(quantity)) {
        return res.status(400).json({ error: 'Choose a chore and child, and enter a quantity greater than 0 (up to 100).' });
      }
      const chore = db.prepare('SELECT * FROM chores WHERE id = ? AND active = 1').get(choreId);
      const member = db.prepare('SELECT id, name, avatar FROM children WHERE id = ?').get(memberId);
      if (!chore) return res.status(404).json({ error: 'Active chore not found.' });
      if (!member) return res.status(404).json({ error: 'Child profile not found.' });
      const completedAt = new Date().toISOString();
      const localDay = localDateKey(new Date(completedAt));
      const nextId = nextMemberId(db, memberId) ?? memberId;
      const insert = db.transaction(() => {
        const result = db.prepare(`INSERT INTO logs (chore_id, member_id, quantity, completed_at, local_day)
          VALUES (?, ?, ?, ?, ?)`).run(choreId, memberId, quantity, completedAt, localDay);
        db.prepare('UPDATE chores SET next_member_id = ? WHERE id = ?').run(nextId, choreId);
        return result.lastInsertRowid;
      });
      const logId = insert();
      const nextMember = db.prepare('SELECT id, name, avatar FROM children WHERE id = ?').get(nextId) || member;
      Promise.resolve(onCompletion({ memberId: nextMemberId(db, memberId) ?? memberId, nextMemberName: nextMember.name, choreName: chore.name }))
        .catch((error) => console.warn('Could not send turn notification:', error?.message || error));
      const log = db.prepare(`SELECT l.id, l.chore_id AS choreId, c.name AS choreName,
        l.member_id AS memberId, m.name AS memberName, l.quantity, l.completed_at AS completedAt,
        l.local_day AS localDay, c.unit, c.points FROM logs l
        JOIN chores c ON c.id = l.chore_id JOIN children m ON m.id = l.member_id WHERE l.id = ?`).get(logId);
      res.status(201).json({ log, nextMember, dashboard: dashboardData(db) });
    } catch (error) { next(error); }
  });

  router.post('/chores', requireParent, (req, res) => {
    const { name, targetPerDay = 1, unit = '', points = 10 } = req.body || {};
    const firstChild = db.prepare('SELECT id FROM children ORDER BY id LIMIT 1').get();
    if (!firstChild) return res.status(409).json({ error: 'Add a child profile before creating chores.' });
    const target = Number(targetPerDay), score = Number(points);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || !Number.isInteger(target) || target < 1 || target > 20 || typeof unit !== 'string' || unit.length > 24 || !Number.isInteger(score) || score < 1 || score > 100) {
      return res.status(400).json({ error: 'Enter a chore name, target (1–20), unit (up to 24 characters), and points (1–100).' });
    }
    const result = db.prepare(`INSERT INTO chores (name, target_per_day, unit, points, next_member_id)
      VALUES (?, ?, ?, ?, ?)`).run(name.trim(), target, unit.trim(), score, firstChild.id);
    res.status(201).json({ id: result.lastInsertRowid });
  });
  router.patch('/chores/:id', requireParent, (req, res) => {
    const id = Number(req.params.id);
    const chore = db.prepare('SELECT * FROM chores WHERE id = ?').get(id);
    if (!chore) return res.status(404).json({ error: 'Chore not found.' });
    const name = req.body?.name === undefined ? chore.name : String(req.body.name).trim();
    const target = req.body?.targetPerDay === undefined ? chore.target_per_day : Number(req.body.targetPerDay);
    const unit = req.body?.unit === undefined ? chore.unit : String(req.body.unit).trim();
    const points = req.body?.points === undefined ? chore.points : Number(req.body.points);
    const active = req.body?.active === undefined ? chore.active : (req.body.active ? 1 : 0);
    if (!name || name.length > 60 || !Number.isInteger(target) || target < 1 || target > 20 || unit.length > 24 || !Number.isInteger(points) || points < 1 || points > 100) {
      return res.status(400).json({ error: 'Invalid chore settings.' });
    }
    db.prepare('UPDATE chores SET name = ?, target_per_day = ?, unit = ?, points = ?, active = ? WHERE id = ?')
      .run(name, target, unit, points, active, id);
    res.json({ ok: true });
  });
  router.delete('/chores/:id', requireParent, (req, res) => {
    const result = db.prepare('UPDATE chores SET active = 0 WHERE id = ?').run(Number(req.params.id));
    if (!result.changes) return res.status(404).json({ error: 'Chore not found.' });
    res.json({ ok: true });
  });

  router.post('/children', requireParent, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const pin = req.body?.pin;
    if (!name || name.length > 32) return res.status(400).json({ error: 'Name must be 1–32 characters.' });
    if (!validChildPin(pin)) return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
    if (pinConflicts(pin)) return res.status(409).json({ error: 'Each child needs a unique PIN that differs from the parent PIN.' });
    const avatarIndex = db.prepare('SELECT COUNT(*) AS count FROM children').get().count % childAvatars.length;
    const { salt, hash } = hashPin(pin);
    const result = db.prepare('INSERT INTO children (name, avatar, pin_salt, pin_hash) VALUES (?, ?, ?, ?)')
      .run(name, childAvatars[avatarIndex], salt, hash);
    res.status(201).json({ id: result.lastInsertRowid });
  });
  router.patch('/children/:id', requireParent, (req, res) => {
    const id = Number(req.params.id);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 32) return res.status(400).json({ error: 'Name must be 1–32 characters.' });
    const result = db.prepare('UPDATE children SET name = ? WHERE id = ?').run(name, id);
    if (!result.changes) return res.status(404).json({ error: 'Child not found.' });
    res.json({ ok: true });
  });
  router.patch('/children/:id/pin', requireParent, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !db.prepare('SELECT id FROM children WHERE id = ?').get(id)) return res.status(404).json({ error: 'Child not found.' });
    const pin = req.body?.pin;
    if (!validChildPin(pin)) return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
    if (pinConflicts(pin, id)) return res.status(409).json({ error: 'Each child needs a unique PIN that differs from the parent PIN.' });
    const { salt, hash } = hashPin(pin);
    const updatePin = db.transaction(() => {
      db.prepare('UPDATE children SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hash, id);
      db.prepare("DELETE FROM auth_sessions WHERE role = 'child' AND child_id = ?").run(id);
    });
    updatePin();
    res.json({ ok: true });
  });
  router.patch('/settings', requireParent, (req, res) => {
    const goal = Number(req.body?.weeklyGoalPoints);
    if (!Number.isInteger(goal) || goal < 1 || goal > 5000) return res.status(400).json({ error: 'Weekly goal must be between 1 and 5000 points.' });
    db.prepare("INSERT INTO settings (key, value) VALUES ('weekly_goal_points', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(goal));
    res.json({ ok: true });
  });
  router.patch('/logs/:id', requireParent, (req, res) => {
    const id = Number(req.params.id);
    const oldLog = db.prepare('SELECT * FROM logs WHERE id = ?').get(id);
    if (!oldLog) return res.status(404).json({ error: 'Log entry not found.' });
    const memberId = req.body?.memberId === undefined ? oldLog.member_id : Number(req.body.memberId);
    const quantity = req.body?.quantity === undefined ? oldLog.quantity : Number(req.body.quantity);
    let completedAt = oldLog.completed_at;
    if (req.body?.completedAt !== undefined) {
      const timestamp = Date.parse(req.body.completedAt);
      if (!Number.isFinite(timestamp)) return res.status(400).json({ error: 'Invalid log correction.' });
      completedAt = new Date(timestamp).toISOString();
    }
    if (!Number.isInteger(memberId) || !db.prepare('SELECT id FROM children WHERE id = ?').get(memberId) || !validQuantity(quantity)) {
      return res.status(400).json({ error: 'Invalid log correction.' });
    }
    const update = db.transaction(() => {
      db.prepare('UPDATE logs SET member_id = ?, quantity = ?, completed_at = ?, local_day = ? WHERE id = ?')
        .run(memberId, quantity, completedAt, localDateKey(new Date(completedAt)), id);
      const latest = db.prepare('SELECT chore_id AS choreId, member_id AS memberId FROM logs WHERE chore_id = ? ORDER BY completed_at DESC, id DESC LIMIT 1').get(oldLog.chore_id);
      if (latest) db.prepare('UPDATE chores SET next_member_id = ? WHERE id = ?').run(nextMemberId(db, latest.memberId), latest.choreId);
    });
    update();
    res.json({ ok: true });
  });
  router.delete('/logs/:id', requireParent, (req, res) => {
    const result = db.prepare('DELETE FROM logs WHERE id = ?').run(Number(req.params.id));
    if (!result.changes) return res.status(404).json({ error: 'Log entry not found.' });
    res.json({ ok: true });
  });

  app.use('/api', router);
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dbPath = process.env.DB_PATH || './data/chorequest.db';
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = createDatabase(dbPath);
  const config = pushConfiguration();
  const sendPush = createPushSender(db, config);
  const adminPin = process.env.ADMIN_PIN || '2468';
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PIN) throw new Error('Set ADMIN_PIN before running in production.');
  if (!process.env.ADMIN_PIN) console.warn('Using development parent PIN 2468. Set ADMIN_PIN before deployment.');
  const trustProxy = process.env.TRUST_PROXY === '1' ? 1 : false;
  const app = createApp({ db, adminPin, onCompletion: sendPush, pushPublicKey: config?.publicKey || null, trustProxy });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log(`Chore Quest listening on port ${port}`));
}
