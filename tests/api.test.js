import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';

let db, server, base;
before(async () => {
  db = createDatabase(':memory:');
  server = createApp({ db, adminPin: '7319', trustProxy: 1, resolvePushHostname: async (hostname) => [{ address: hostname === 'internal.example' ? '10.1.2.3' : '93.184.216.34', family: 4 }] }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
});

async function api(path, options = {}, cookie = null) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, setCookie: response.headers.get('set-cookie') };
}
function json(body) { return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }
async function login(kind, pin, extraHeaders = {}) {
  const result = await api(`/auth/${kind}-login`, { method: 'POST', ...json({ pin }), headers: { 'content-type': 'application/json', ...extraHeaders } });
  return { ...result, cookie: result.setCookie?.split(';')[0] };
}

 test('health is public, dashboard is private, and seed data is preserved', async () => {
  assert.equal((await api('/health')).status, 200);
  assert.equal((await api('/data')).status, 401);
  const parent = await login('parent', '7319');
  assert.equal(parent.status, 200);
  assert.deepEqual(parent.body, { role: 'parent' });
  assert.match(parent.setCookie, /HttpOnly/i);
  assert.match(parent.setCookie, /SameSite=Strict/i);
  const data = await api('/data', {}, parent.cookie);
  assert.equal(data.status, 200);
  assert.deepEqual(data.body.children.map((child) => child.name), ['Kid 1', 'Kid 2']);
  assert.deepEqual(data.body.chores.map((chore) => chore.name), ['Cat litter', 'Dishwasher', 'Folding laundry', 'Hanging laundry']);
  assert.equal(data.body.chores.find((chore) => chore.name === 'Cat litter').targetPerDay, 2);
  assert.equal(data.body.chores.find((chore) => chore.name === 'Folding laundry').unit, 'loads');
  assert.deepEqual(data.body.children.map((child) => child.pinConfigured), [0, 0]);
  assert.equal((await api('/auth/me', {}, parent.cookie)).body.role, 'parent');
});

test('child PIN sessions bind chore logs to the authenticated child', async () => {
  const parent = await login('parent', '7319');
  const pin1 = await api('/children/1/pin', { method: 'PATCH', ...json({ pin: '1111' }) }, parent.cookie);
  const pin2 = await api('/children/2/pin', { method: 'PATCH', ...json({ pin: '2222' }) }, parent.cookie);
  assert.equal(pin1.status, 200);
  assert.equal(pin2.status, 200);
  assert.equal((await api('/children/2/pin', { method: 'PATCH', ...json({ pin: '1111' }) }, parent.cookie)).status, 409);
  assert.equal((await api('/children/1/pin', { method: 'PATCH', ...json({ pin: '7319' }) }, parent.cookie)).status, 409);
  const stored = db.prepare('SELECT pin_salt, pin_hash FROM children WHERE id = 1').get();
  assert.notEqual(stored.pin_hash, '1111');
  assert.equal(stored.pin_salt.length, 32);

  const kid1 = await login('child', '1111');
  assert.equal(kid1.status, 200);
  assert.deepEqual(kid1.body, { role: 'child', child: { id: 1, name: 'Kid 1', avatar: '🦊' } });
  const me = await api('/auth/me', {}, kid1.cookie);
  assert.equal(me.body.child.id, 1);
  const familyBoard = await api('/data', {}, kid1.cookie);
  assert.deepEqual(familyBoard.body.children.map((child) => child.name), ['Kid 1', 'Kid 2']);

  const litter = familyBoard.body.chores.find((chore) => chore.name === 'Cat litter');
  const spoofedLog = await api('/logs', { method: 'POST', ...json({ choreId: litter.id, memberId: 2, quantity: 1 }) }, kid1.cookie);
  assert.equal(spoofedLog.status, 403);
  assert.equal((await api('/logs', {}, kid1.cookie)).body.length, 0);
  const ownLog = await api('/logs', { method: 'POST', ...json({ choreId: litter.id, quantity: 1 }) }, kid1.cookie);
  assert.equal(ownLog.status, 201);
  assert.equal(ownLog.body.log.memberId, 1);
  assert.equal(ownLog.body.nextMember.id, 2);
  assert.equal((await api('/settings', { method: 'PATCH', ...json({ weeklyGoalPoints: 200 }) }, kid1.cookie)).status, 403);
  assert.equal((await api('/push/subscriptions', { method: 'POST', ...json({ memberId: 2, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/e1', keys: { p256dh: 'a', auth: 'b' } } }) }, kid1.cookie)).status, 403);
});

test('parent session uses settings without a second PIN and can add kids', async () => {
  const parent = await login('parent', '7319');
  assert.equal(parent.status, 200);
  const savedGoal = await api('/settings', { method: 'PATCH', ...json({ weeklyGoalPoints: 200 }) }, parent.cookie);
  assert.equal(savedGoal.status, 200);
  assert.equal((await api('/data', {}, parent.cookie)).body.weeklyGoalPoints, 200);

  const childLoginDenied = await api('/children', { method: 'POST', ...json({ name: 'Casey', pin: '3333' }) });
  assert.equal(childLoginDenied.status, 401);
  const created = await api('/children', { method: 'POST', ...json({ name: 'Casey', pin: '3333' }) }, parent.cookie);
  assert.equal(created.status, 201);
  const children = (await api('/data', {}, parent.cookie)).body.children;
  assert.deepEqual(children.map((child) => child.name), ['Kid 1', 'Kid 2', 'Casey']);
  assert.deepEqual(children.map((child) => child.pinConfigured), [1, 1, 1]);
  assert.deepEqual(Object.keys(children[0]).sort(), ['avatar', 'id', 'name', 'pinConfigured']);
  const parentLog = await api('/logs', { method: 'POST', ...json({ choreId: (await api('/data', {}, parent.cookie)).body.chores[0].id, memberId: children[2].id }) }, parent.cookie);
  assert.equal(parentLog.status, 201);
  assert.equal(parentLog.body.log.memberId, children[2].id);

  const child1 = await login('child', '1111');
  const child2 = await login('child', '2222');
  const child3 = await login('child', '3333');
  assert.equal(child1.status, 200);
  assert.equal(child2.status, 200);
  assert.equal(child3.status, 200);
  const choreId = (await api('/data', {}, child2.cookie)).body.chores[0].id;
  const turn2 = await api('/logs', { method: 'POST', ...json({ choreId }) }, child2.cookie);
  const turn3 = await api('/logs', { method: 'POST', ...json({ choreId }) }, child3.cookie);
  const turn1 = await api('/logs', { method: 'POST', ...json({ choreId }) }, child1.cookie);
  assert.deepEqual([turn2.body.nextMember.id, turn3.body.nextMember.id, turn1.body.nextMember.id], [3, 1, 2]);

  const reset = await api('/children/1/pin', { method: 'PATCH', ...json({ pin: '4444' }) }, parent.cookie);
  assert.equal(reset.status, 200);
  assert.equal((await api('/auth/me', {}, child1.cookie)).status, 401);
  assert.equal((await login('child', '1111')).status, 401);
  assert.equal((await login('child', '4444')).status, 200);
});

test('child cannot manage profiles and logout revokes the parent session', async () => {
  const child = await login('child', '2222');
  assert.equal((await api('/children', { method: 'POST', ...json({ name: 'Nope', pin: '5555' }) }, child.cookie)).status, 403);
  const parent = await login('parent', '7319');
  assert.equal(parent.status, 200);
  assert.equal((await api('/auth/logout', { method: 'POST' }, parent.cookie)).status, 200);
  assert.equal((await api('/data', {}, parent.cookie)).status, 401);
});

test('push subscriptions require authentication and child ownership', async () => {
  const unauthenticated = await api('/push/subscriptions', { method: 'POST', ...json({ memberId: 1, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/e2', keys: { p256dh: 'k', auth: 'a' } } }) });
  assert.equal(unauthenticated.status, 401);
  const child = await login('child', '2222');
  const wrongChild = await api('/push/subscriptions', { method: 'POST', ...json({ memberId: 1, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/e2', keys: { p256dh: 'k', auth: 'a' } } }) }, child.cookie);
  assert.equal(wrongChild.status, 403);
  const userInfoEndpoint = await api('/push/subscriptions', { method: 'POST', ...json({ memberId: 2, subscription: { endpoint: 'https://trusted.example@attacker.example/steal', keys: { p256dh: 'k', auth: 'a' } } }) }, child.cookie);
  assert.equal(userInfoEndpoint.status, 400);
  const privateEndpoint = await api('/push/subscriptions', { method: 'POST', ...json({ memberId: 2, subscription: { endpoint: 'https://internal.example/push', keys: { p256dh: 'k', auth: 'a' } } }) }, child.cookie);
  assert.equal(privateEndpoint.status, 400);
  const rightChild = await api('/push/subscriptions', { method: 'POST', ...json({ memberId: 2, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/e2', keys: { p256dh: 'k', auth: 'a' } } }) }, child.cookie);
  assert.equal(rightChild.status, 201);
});

test('adding a chore returns a controlled error when no child profile exists', async () => {
  const emptyDb = createDatabase(':memory:');
  emptyDb.exec('DELETE FROM chores; DELETE FROM children;');
  const emptyServer = createApp({ db: emptyDb, adminPin: '7319' }).listen(0, '127.0.0.1');
  await new Promise((resolve) => emptyServer.once('listening', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${emptyServer.address().port}/api`;
    const loginResponse = await fetch(`${baseUrl}/auth/parent-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '7319' }) });
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${baseUrl}/chores`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'A chore' }) });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Add a child profile/);
  } finally {
    await new Promise((resolve, reject) => emptyServer.close((error) => error ? reject(error) : resolve()));
    emptyDb.close();
  }
});

test('login throttles spoofed forwarding IPs and persists across app recreation', async () => {
  for (let index = 0; index < 5; index += 1) {
    const result = await login('child', '9999', { 'x-forwarded-for': `198.51.100.${index + 1}` });
    assert.equal(result.status, 401);
  }
  const blocked = await login('child', '2222', { 'x-forwarded-for': '203.0.113.55' });
  assert.equal(blocked.status, 429);

  const restartedServer = createApp({ db, adminPin: '7319', trustProxy: 1 }).listen(0, '127.0.0.1');
  await new Promise((resolve) => restartedServer.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${restartedServer.address().port}/api/auth/child-login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.99' }, body: JSON.stringify({ pin: '2222' })
    });
    assert.equal(response.status, 429);
  } finally {
    await new Promise((resolve, reject) => restartedServer.close((error) => error ? reject(error) : resolve()));
  }
});
