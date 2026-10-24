import assert from 'node:assert/strict';
import test from 'node:test';
import { badgeFor, mondayDateKey, validQuantity } from '../server/domain.js';

test('quantity validation only accepts a positive finite number up to 100', () => {
  assert.equal(validQuantity(1), true);
  assert.equal(validQuantity('2.5'), true);
  assert.equal(validQuantity(0), false);
  assert.equal(validQuantity(-1), false);
  assert.equal(validQuantity(101), false);
  assert.equal(validQuantity('nope'), false);
});

test('badges grow with points or completed chores', () => {
  assert.equal(badgeFor(0, 0).name, 'Ready to start');
  assert.equal(badgeFor(10, 1).name, 'First Spark');
  assert.equal(badgeFor(50, 2).name, 'Super Helper');
  assert.equal(badgeFor(10, 12).name, 'Chore Champion');
});

test('week starts on Monday in the configured local calendar', () => {
  process.env.TZ = 'UTC';
  assert.equal(mondayDateKey(new Date('2026-10-20T12:00:00Z')), '2026-10-19');
  assert.equal(mondayDateKey(new Date('2026-10-25T12:00:00Z')), '2026-10-19');
});
