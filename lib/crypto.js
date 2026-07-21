/**
 * Token crypto + auth helpers.
 *
 * - encrypt()/decrypt(): AES-256-GCM for OAuth tokens at rest (Meta doc §7).
 *   Key comes from TOKEN_ENC_KEY (64 hex chars) or is derived from SESSION_SECRET.
 * - randomToken(): per-org bearer token issued at org creation.
 * - safeEqual(): constant-time comparison for token checks.
 *
 * Back-compat: decrypt() returns any value not prefixed "v1:" unchanged, so a DB
 * written before encryption was added still reads correctly.
 */

const crypto = require('crypto');

let cachedKey;
function getKey() {
  if (cachedKey) return cachedKey;
  const hex = process.env.TOKEN_ENC_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    cachedKey = Buffer.from(hex, 'hex');
  } else {
    const secret = process.env.SESSION_SECRET || 'leadpilot-local-dev-secret';
    cachedKey = crypto.scryptSync(secret, 'leadpilot-token-salt-v1', 32);
  }
  return cachedKey;
}

function encrypt(plaintext) {
  if (plaintext == null) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(blob) {
  if (blob == null) return blob;
  if (typeof blob !== 'string' || !blob.startsWith('v1:')) return blob; // legacy plaintext
  const [, ivHex, tagHex, ctHex] = blob.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { encrypt, decrypt, randomToken, safeEqual };
