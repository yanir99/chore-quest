import { lookup } from 'node:dns/promises';
import { Agent } from 'node:https';
import { BlockList, isIP } from 'node:net';

const deniedV4 = new BlockList();
const deniedV6 = new BlockList();
const deniedSubnets = [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.88.99.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 96, 'ipv6'], ['::ffff:0:0', 96, 'ipv6'], ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'], ['100::', 64, 'ipv6'], ['2001::', 23, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'], ['2002::', 16, 'ipv6'], ['3fff::', 20, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['fec0::', 10, 'ipv6'], ['ff00::', 8, 'ipv6']
];
for (const [address, prefix, family] of deniedSubnets) {
  (family === 'ipv4' ? deniedV4 : deniedV6).addSubnet(address, prefix, family);
}

const localSuffixes = ['.localhost', '.local', '.internal', '.home', '.lan', '.test', '.example', '.invalid'];
const defaultResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function resolveSafePushEndpoint(endpoint, resolveHostname = defaultResolver) {
  if (typeof endpoint !== 'string' || endpoint.length > 4096) return null;
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.hostname.endsWith('.')) return null;

  const hostname = url.hostname.toLowerCase();
  const addressHost = hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.length > 253 || !hostname.includes('.') || isIP(addressHost)) return null;
  if (localSuffixes.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) return null;

  let answers;
  try { answers = await resolveHostname(hostname); } catch { return null; }
  if (!Array.isArray(answers) || answers.length === 0) return null;
  const addresses = answers.map(({ address }) => ({ address, family: isIP(address) }));
  if (addresses.some(({ family }) => !family)) return null;
  if (addresses.some(({ address, family }) => (family === 4 ? deniedV4 : deniedV6).check(address, family === 4 ? 'ipv4' : 'ipv6'))) return null;
  return { hostname, addresses };
}

export async function isSafePushEndpoint(endpoint, resolveHostname = defaultResolver) {
  return (await resolveSafePushEndpoint(endpoint, resolveHostname)) !== null;
}

export function createPinnedHttpsAgent(target) {
  return new Agent({
    lookup(hostname, options, callback) {
      if (hostname !== target.hostname) return callback(new Error('Unexpected push host lookup.'));
      const candidates = options?.family ? target.addresses.filter((address) => address.family === options.family) : target.addresses;
      if (candidates.length === 0) {
        const error = new Error('No validated push address matches the requested address family.');
        error.code = 'ENOTFOUND';
        return callback(error);
      }
      if (options?.all) return callback(null, candidates);
      const first = candidates[0];
      callback(null, first.address, first.family);
    }
  });
}
