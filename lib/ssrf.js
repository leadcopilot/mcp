/**
 * SSRF guard for outbound fetches of caller/derived URLs.
 *
 * Blocks non-http(s) schemes, literal private/loopback/link-local IPs,
 * localhost-style hostnames, and hostnames that resolve into private ranges
 * (e.g. cloud metadata at 169.254.169.254).
 *
 * Note: this is a resolve-then-check guard, so a determined DNS-rebinding
 * attacker could still race the resolution (TOCTOU). Pinning the resolved IP
 * for the actual connection would require lower-level socket control than
 * Playwright/trafilatura expose; this closes the practical exposure.
 */

const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;                 // loopback
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;    // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80')) return true;    // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error(`Invalid URL: ${rawUrl}`); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme "${u.protocol}" — only http/https allowed`);
  }

  const host = u.hostname;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked private/loopback address: ${host}`);
    return rawUrl;
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) {
    throw new Error(`Blocked internal host: ${host}`);
  }

  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error(`DNS resolution failed for ${host}`); }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`Host ${host} resolves to a private address (${a.address})`);
  }
  return rawUrl;
}

module.exports = { assertPublicUrl, isPrivateIp };
