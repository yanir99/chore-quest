import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase } from '../server/db.js';
import { createSession, getSession, hashPin, revokeSession, SESSION_TTL_MS, validChildPin, verifyPin } from '../server/auth.js';

test('child PIN validation and salted hashing', () => {
  assert.equal(validChildPin('1234'), true);
  assert.equal(validChildPin('12345678'), true);
  assert.equal(validChildPin('123'), false);
  assert.equal(validChildPin('12a4'), false);
  assert.equal(validChildPin('123456789'), false);
  const first = hashPin('1234');
  const second = hashPin('1234');
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, '1234');
  assert.equal(verifyPin('1234', first.salt, first.hash), true);
  assert.equal(verifyPin('9999', first.salt, first.hash), false);
});

test('sessions store only a hashed token, expire, and can be revoked', () => {
  const db = createDatabase(':memory:');
  try {
    const created = createSession(db, 'parent', null, 1000);
    assert.equal(created.expiresAt, 1000 + SESSION_TTL_MS);
    assert.equal(getSession(db, created.token, 1000).role, 'parent');
    assert.notEqual(db.prepare('SELECT token_hash FROM auth_sessions').get().token_hash, created.token);
    assert.equal(getSession(db, created.token, created.expiresAt), null);
    const second = createSession(db, 'child', 1, 2000);
    revokeSession(db, second.token);
    assert.equal(getSession(db, second.token, 2000), null);
  } finally { db.close(); }
});

test('existing child database migrates PIN columns without losing household data', () => {
  const tempRoot = process.env.TMPDIR || '/opt/data/cache/scratch';
  const folder = fs.mkdtempSync(path.join(tempRoot, 'chore-quest-migration-'));
  const file = path.join(folder, 'legacy.db');
  const oldDb = new Database(file);
  oldDb.exec(`CREATE TABLE children (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar TEXT NOT NULL);
    INSERT INTO children (name, avatar) VALUES ('Ari', '🦊');`);
  oldDb.close();
  const migrated = createDatabase(file);
  try {
    const columns = new Set(migrated.pragma('table_info(children)').map((column) => column.name));
    assert.equal(columns.has('pin_salt'), true);
    assert.equal(columns.has('pin_hash'), true);
    assert.deepEqual(migrated.prepare('SELECT id, name, avatar FROM children').get(), { id: 1, name: 'Ari', avatar: '🦊' });
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM chores').get().count, 4);
  } finally {
    migrated.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
