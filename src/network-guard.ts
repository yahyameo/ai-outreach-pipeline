import { lookup as dnsLookup, LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Websites to fetch come from scraped data (Google Maps listings, lead
 * records), so any of them could point at a private network or a cloud
 * metadata endpoint. Every outbound page fetch goes through the agents below.
 *
 * The check runs inside the agents' DNS lookup, i.e. on the exact address
 * the socket then connects to. Checking DNS first and fetching afterwards
 * would let a hostname resolve to a public address for the check and a
 * private one for the request (DNS rebinding). It also covers every redirect
 * hop, because axios hands the same agents to each one.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. cloud metadata
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, incl. broadcast
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['ff00::', 8],         // multicast
] as const) blocked.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, '').toLowerCase();
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) reaches the IPv4 host it embeds.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPublicAddress(mapped[1]);
  const family = isIP(value);
  if (family === 4) return !blocked.check(value, 'ipv4');
  if (family === 6) return !blocked.check(value, 'ipv6');
  return false;
}

/** For URL validation before any network access: literal IPs and local names. */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  return isIP(host) !== 0 && !isPublicAddress(host);
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function publicOnlyLookup(hostname: string, options: { all?: boolean } & object, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses as LookupAddress[];
    if (!list.length || list.some(({ address }) => !isPublicAddress(address))) {
      return callback(
        Object.assign(new Error(`${hostname} resolves to a non-public network address.`), { code: 'ENOTPUBLIC' }),
        '',
      );
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

export const publicHttpAgent = new http.Agent({ lookup: publicOnlyLookup as never });
export const publicHttpsAgent = new https.Agent({ lookup: publicOnlyLookup as never });

export const RESEARCH_USER_AGENT = 'Mozilla/5.0 (compatible; OutreachResearchBot/1.0)';
