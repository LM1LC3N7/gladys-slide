// -----------------------------------------------------------------------------
// HTTP Digest authentication of the API v1 of the Slide (RFC 7616, MD5,
// qop "auth"), as goslide-api `GoSlideLocal._make_digest_auth` (Apache-2.0)
// does it: user "user", the device code as the password, a fresh nonce for
// every request (nc 00000001), a random cnonce.
//
// The challenge comes from the network: read in one linear pass, bounded,
// only the known parameters kept (in a Map), and any value that could break
// the header we send back (a quote, a backslash, a control character) makes
// it "not a Slide" rather than being copied.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { LIMITS } from '../constants.js';

const KNOWN = new Set(['realm', 'nonce', 'qop', 'opaque', 'algorithm']);
const SAFE = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{0,256}$/;

/**
 * The parameters of a Digest challenge, or undefined when the header is not
 * one we can answer (another scheme, no nonce, a value we will not copy).
 * @param {string|string[]|undefined} header the WWW-Authenticate header
 * @returns {Map<string, string>|undefined}
 */
export function parseChallenge(header) {
  const text = Array.isArray(header) ? header[0] : header;
  if (typeof text !== 'string' || text.length > LIMITS.challengeBytes) {
    return undefined;
  }
  const scheme = /^\s*Digest\s+/i.exec(text);
  if (!scheme) {
    return undefined;
  }
  const params = new Map();
  let i = scheme[0].length;
  while (i < text.length) {
    // name
    while (i < text.length && (text[i] === ' ' || text[i] === ',' || text[i] === '\t')) {
      i += 1;
    }
    if (i >= text.length) {
      break;
    }
    const nameStart = i;
    while (i < text.length && /[A-Za-z0-9_-]/.test(text[i])) {
      i += 1;
    }
    const name = text.slice(nameStart, i).toLowerCase();
    if (name === '' || text[i] !== '=') {
      return undefined;
    }
    i += 1;
    let value = '';
    if (text[i] === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          // An escaped character: never copied back into our header.
          return undefined;
        }
        value += text[i];
        i += 1;
      }
      if (text[i] !== '"') {
        return undefined;
      }
      i += 1;
    } else {
      const start = i;
      while (i < text.length && text[i] !== ',' && text[i] !== ' ') {
        i += 1;
      }
      value = text.slice(start, i);
    }
    if (KNOWN.has(name) && !params.has(name)) {
      if (!SAFE.test(value)) {
        return undefined;
      }
      params.set(name, value);
    }
  }
  if (!params.get('nonce')) {
    return undefined;
  }
  const algorithm = (params.get('algorithm') ?? 'MD5').toUpperCase();
  const qop = (params.get('qop') ?? '').split(',').map((q) => q.trim().toLowerCase());
  if (algorithm !== 'MD5' || !qop.includes('auth')) {
    // goslide-api refuses them too: the Slide always asks MD5 with qop=auth.
    return undefined;
  }
  return params;
}

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

/**
 * The Authorization header answering a challenge.
 * @param {{ username: string, password: string, method: string, uri: string,
 *   challenge: Map<string, string>, cnonce?: string }} options
 */
export function digestHeader({ username, password, method, uri, challenge, cnonce }) {
  const realm = challenge.get('realm') ?? '';
  const nonce = challenge.get('nonce');
  const nc = '00000001';
  const client = cnonce ?? randomBytes(4).toString('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${client}:auth:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    'algorithm="MD5"',
    'qop=auth',
    `nc=${nc}`,
    `cnonce="${client}"`,
    `response="${response}"`,
  ];
  if (challenge.has('opaque')) {
    parts.push(`opaque="${challenge.get('opaque')}"`);
  }
  return `Digest ${parts.join(', ')}`;
}
