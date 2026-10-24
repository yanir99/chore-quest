import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinnedHttpsAgent, isSafePushEndpoint, resolveSafePushEndpoint } from '../server/push-endpoint.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('accepts HTTPS push endpoints with public IPv4 or IPv6 DNS answers', async () => {
  assert.equal(await isSafePushEndpoint('https://fcm.googleapis.com/fcm/send/token', publicDns), true);
  assert.equal(await isSafePushEndpoint('https://push.example.net/push', async () => [{ address: '2001:4860:4860::8888', family: 6 }]), true);
});

test('pins outgoing HTTPS lookup to the addresses validated for the push endpoint', async () => {
  const target = await resolveSafePushEndpoint('https://fcm.googleapis.com/fcm/send/token', async () => [
    { address: '93.184.216.34', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }
  ]);
  assert.ok(target);
  const agent = createPinnedHttpsAgent(target);
  try {
    const addresses = await new Promise((resolve, reject) => agent.options.lookup(target.hostname, { all: true }, (error, result) => error ? reject(error) : resolve(result)));
    assert.deepEqual(addresses, target.addresses);
    const onlyV6 = await new Promise((resolve, reject) => agent.options.lookup(target.hostname, { family: 6 }, (error, address, family) => error ? reject(error) : resolve({ address, family })));
    assert.deepEqual(onlyV6, { address: '2001:4860:4860::8888', family: 6 });
    await assert.rejects(() => new Promise((resolve, reject) => agent.options.lookup(target.hostname, { family: 2 }, (error, address) => error ? reject(error) : resolve(address))), /No validated push address/);
    await assert.rejects(() => new Promise((resolve, reject) => agent.options.lookup('attacker.example', {}, (error, address) => error ? reject(error) : resolve(address))), /Unexpected push host lookup/);
  } finally { agent.destroy(); }
});

test('rejects malformed, credentialed, insecure, nonstandard-port, and IP-literal endpoints', async () => {
  assert.equal(await isSafePushEndpoint('not a URL', publicDns), false);
  assert.equal(await isSafePushEndpoint('http://fcm.googleapis.com/fcm/send/token', publicDns), false);
  assert.equal(await isSafePushEndpoint('https://trusted.example@attacker.example/push', publicDns), false);
  assert.equal(await isSafePushEndpoint('https://fcm.googleapis.com:8443/push', publicDns), false);
  assert.equal(await isSafePushEndpoint('https://127.0.0.1/push', publicDns), false);
  assert.equal(await isSafePushEndpoint('https://[::1]/push', publicDns), false);
});

test('rejects DNS names resolving to private, loopback, link-local, or mixed private/public addresses', async () => {
  const resolver = async () => [{ address: '10.1.2.3', family: 4 }];
  assert.equal(await isSafePushEndpoint('https://internal.example/push', resolver), false);
  assert.equal(await isSafePushEndpoint('https://mixed.example/push', async () => [
    { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }
  ]), false);
  assert.equal(await isSafePushEndpoint('https://linklocal.example/push', async () => [{ address: '169.254.1.2', family: 4 }]), false);
  assert.equal(await isSafePushEndpoint('https://private-v6.example/push', async () => [{ address: 'fd00::1', family: 6 }]), false);
  assert.equal(await isSafePushEndpoint('https://nat64.example/push', async () => [{ address: '64:ff9b::c0a8:1', family: 6 }]), false);
  assert.equal(await isSafePushEndpoint('https://compatible-v6.example/push', async () => [{ address: '::c0a8:1', family: 6 }]), false);
});

test('rejects local-only hostnames and unresolved hosts', async () => {
  assert.equal(await isSafePushEndpoint('https://metadata.google.internal/latest', publicDns), false);
  assert.equal(await isSafePushEndpoint('https://push.local/push', publicDns), false);
  assert.equal(await isSafePushEndpoint('https://unknown.example/push', async () => { throw new Error('no DNS'); }), false);
});
