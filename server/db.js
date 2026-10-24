import Database from 'better-sqlite3';
import { localDateKey, mondayDateKey } from './domain.js';

const starterChores = [
  { name: 'Cat litter', target_per_day: 2, unit: '', points: 10 },
  { name: 'Dishwasher', target_per_day: 1, unit: '', points: 10 },
  { name: 'Folding laundry', target_per_day: 1, unit: 'loads', points: 15 },
  { name: 'Hanging laundry', target_per_day: 1, unit: 'loads', points: 15 }
];

export function createDatabase(dbPath = process.env.DB_PATH || './data/chorequest.db') {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS children (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 32),
      avatar TEXT NOT NULL DEFAULT '🦊',
      pin_salt TEXT,
      pin_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS chores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
      target_per_day INTEGER NOT NULL DEFAULT 1 CHECK(target_per_day BETWEEN 1 AND 20),
      unit TEXT NOT NULL DEFAULT '' CHECK(length(unit) <= 24),
      points INTEGER NOT NULL DEFAULT 10 CHECK(points BETWEEN 1 AND 100),
      active INTEGER NOT NULL DEFAULT 1,
      next_member_id INTEGER NOT NULL REFERENCES children(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chore_id INTEGER NOT NULL REFERENCES chores(id),
      member_id INTEGER NOT NULL REFERENCES children(id),
      quantity REAL NOT NULL CHECK(quantity > 0 AND quantity <= 100),
      completed_at TEXT NOT NULL,
      local_day TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(member_id, endpoint)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('parent', 'child')),
      child_id INTEGER REFERENCES children(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip_hash TEXT PRIMARY KEY,
      window_started INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,
      blocked_until INTEGER NOT NULL DEFAULT 0
    );
  `);

  const childColumns = new Set(db.pragma('table_info(children)').map((column) => column.name));
  if (!childColumns.has('pin_salt')) db.exec('ALTER TABLE children ADD COLUMN pin_salt TEXT');
  if (!childColumns.has('pin_hash')) db.exec('ALTER TABLE children ADD COLUMN pin_hash TEXT');

  const seed = db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS count FROM children').get().count === 0) {
      const addChild = db.prepare('INSERT INTO children (name, avatar) VALUES (?, ?)');
      addChild.run('Kid 1', '🦊');
      addChild.run('Kid 2', '🐻');
    }
    if (db.prepare('SELECT COUNT(*) AS count FROM chores').get().count === 0) {
      const firstChild = db.prepare('SELECT id FROM children ORDER BY id LIMIT 1').get().id;
      const addChore = db.prepare(`INSERT INTO chores
        (name, target_per_day, unit, points, next_member_id) VALUES (?, ?, ?, ?, ?)`);
      for (const chore of starterChores) {
        addChore.run(chore.name, chore.target_per_day, chore.unit, chore.points, firstChild);
      }
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('weekly_goal_points', '100')").run();
  });
  seed();
  return db;
}

export function dashboardData(db, now = new Date()) {
  const today = localDateKey(now);
  const weekStart = mondayDateKey(now);
  const children = db.prepare('SELECT id, name, avatar, (pin_hash IS NOT NULL) AS pinConfigured FROM children ORDER BY id').all();
  const chores = db.prepare(`SELECT c.id, c.name, c.target_per_day AS targetPerDay, c.unit,
      c.points, c.active, c.next_member_id AS nextMemberId,
      m.name AS nextMemberName, m.avatar AS nextMemberAvatar,
      (SELECT COUNT(*) FROM logs l WHERE l.chore_id = c.id AND l.local_day = ?) AS doneToday
      FROM chores c JOIN children m ON m.id = c.next_member_id
      WHERE c.active = 1 ORDER BY c.id`).all(today);
  const logs = db.prepare(`SELECT l.id, l.chore_id AS choreId, c.name AS choreName,
      l.member_id AS memberId, m.name AS memberName, m.avatar AS memberAvatar,
      l.quantity, l.completed_at AS completedAt, l.local_day AS localDay, c.unit, c.points
      FROM logs l JOIN chores c ON c.id = l.chore_id JOIN children m ON m.id = l.member_id
      ORDER BY l.completed_at DESC, l.id DESC LIMIT 30`).all();
  const scores = db.prepare(`SELECT m.id AS memberId, m.name, m.avatar,
      COALESCE(SUM(c.points), 0) AS points, COUNT(l.id) AS choresDone
      FROM children m LEFT JOIN logs l ON l.member_id = m.id AND l.local_day >= ?
      LEFT JOIN chores c ON c.id = l.chore_id
      GROUP BY m.id ORDER BY points DESC, choresDone DESC, m.id`).all(weekStart);
  const goal = Number(db.prepare("SELECT value FROM settings WHERE key = 'weekly_goal_points'").get()?.value || 100);
  return { children, chores, logs, scores, weeklyGoalPoints: goal, today, weekStart };
}

export function nextMemberId(db, currentMemberId) {
  const ids = db.prepare('SELECT id FROM children ORDER BY id').all().map((row) => row.id);
  if (ids.length === 0) return null;
  const index = ids.indexOf(Number(currentMemberId));
  return ids[(index < 0 ? 0 : index + 1) % ids.length];
}
