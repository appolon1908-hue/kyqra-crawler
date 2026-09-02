import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

import { Agent } from 'undici';

const callbackAllowlist = (): string[] =>
  (process.env.CALLBACK_ALLOWLIST || 'kyqra.com,10.40.0.1')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

const metadataHostnames = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data.ec2.internal',
  'metadata',
]);
const resolvedCrawlTargets = new Map<string, string>();

const configuredHosts = (name: string): string[] =>
  (process.env[name] || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

const hostMatches = (host: string, configured: string[]): boolean =>
  configured.some((value) => host === value || host.endsWith(`.${value}`));

export const isCallbackAllowed = (rawUrl: string): boolean => {
  const url = new URL(rawUrl);
  const protocolAllowed =
    url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '10.40.0.1');
  return (
    protocolAllowed &&
    callbackAllowlist().some(
      (allowedHost) => url.hostname === allowedHost || url.hostname.endsWith(`.${allowedHost}`),
    )
  );
};

export const isProhibitedAddress = (address: string): boolean => {
  if (address === '10.40.0.1') return false;
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number);
    const first = octets[0];
    const second = octets[1];
    const third = octets[2];
    if (first === undefined || second === undefined || third === undefined) return true;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) return isProhibitedAddress(value.slice(7));
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('2001:db8:')
  );
};

export const createPinnedCallbackAgent = async (rawUrl: string): Promise<Agent> => {
  if (!isCallbackAllowed(rawUrl)) throw new Error('callback_not_allowed');
  const hostname = new URL(rawUrl).hostname;
  const resolved = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIPv4(hostname) ? 4 : 6 }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0 || resolved.some((item) => isProhibitedAddress(item.address))) {
    throw new Error('callback_destination_rejected');
  }
  const pinned = resolved[0];
  if (!pinned) throw new Error('callback_destination_rejected');

  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    },
  });
};

export const validateCrawlTarget = async (rawUrl: string): Promise<void> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('crawl_target_invalid');
  }
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    Boolean(url.username || url.password) ||
    metadataHostnames.has(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    hostMatches(host, configuredHosts('CRAWL_HOST_DENYLIST'))
  ) {
    throw new Error('crawl_target_denied');
  }
  const allowlist = configuredHosts('CRAWL_HOST_ALLOWLIST');
  if (allowlist.length > 0 && !hostMatches(host, allowlist)) {
    throw new Error('crawl_target_not_allowlisted');
  }
  const resolved = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true, verbatim: true });
  if (resolved.length === 0) throw new Error('crawl_target_unresolvable');
  const addresses = [...new Set(resolved.map(({ address }) => address))].sort();
  if (
    process.env.KYQRA_ALLOW_TEST_TARGETS !== 'true' &&
    addresses.some((address) => isProhibitedAddress(address))
  ) {
    throw new Error('crawl_target_private_address');
  }
  const fingerprint = addresses.join(',');
  const prior = resolvedCrawlTargets.get(host);
  if (prior && prior !== fingerprint) throw new Error('crawl_target_dns_rebinding');
  resolvedCrawlTargets.set(host, fingerprint);
};

export const callbackSignatureInput = (
  method: string,
  path: string,
  timestamp: string,
  eventId: string,
  source: string,
  body: string,
): string => {
  const normalizedPath = `/${path.split('/').filter(Boolean).join('/')}`;
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return ['v1', method.toUpperCase(), normalizedPath, timestamp, eventId, source, bodyHash].join(
    '\n',
  );
};
