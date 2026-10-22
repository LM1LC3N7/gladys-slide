// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The device codes
// are kept here only: never logged, never in /data (only the salted
// fingerprint of a code a Slide REFUSED, see src/store.js), never in a status
// or an error.
// -----------------------------------------------------------------------------

import { LIMITS, MAX_SLIDES, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  slides: '',
  poll_interval: POLL_INTERVAL.default,
  allow_calibration: false,
  language: 'fr',
};

/** The optional fields without a default in the manifest (the codes are a secret). */
const OPTIONAL = { device_codes: '' };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A text read from the Slide, without control characters, trimmed and cut. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const char of value.slice(0, max * 2)) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim().slice(0, max);
}

/**
 * One address typed by the user: an IPv4 address or a host name, with an
 * optional port. A pasted URL ("http://192.168.1.40/rpc/Slide.GetInfo") is
 * reduced to its host. Credentials in it ("user:pass@host") are refused and
 * never shown; names in .local are refused (mDNS does not resolve in the
 * container).
 * @returns {{ address?: { host: string, port: number }, invalid?: string, credentials?: boolean, local?: boolean }}
 */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (text.includes('@')) {
    return { credentials: true };
  }
  if (text.length > 260) {
    return { invalid: `${text.slice(0, 40)}…` };
  }
  const shown = text.slice(0, 60);
  if (/^https:\/\//i.test(text)) {
    // The local API answers in plain HTTP only.
    return { invalid: shown };
  }
  text = text.replace(/^http:\/\//i, '').replace(/[/?#].*$/, '');
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text.toLowerCase());
  if (!match) {
    return { invalid: shown };
  }
  const [, host, portText] = match;
  const port = portText === undefined ? 80 : Number(portText);
  if (port < 1 || port > 65535 || host.length > 253) {
    return { invalid: shown };
  }
  if (/\.local\.?$/.test(host)) {
    return { local: true, invalid: shown };
  }
  const valid =
    IPV4.test(host) || (!/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l)));
  return valid ? { address: { host, port } } : { invalid: shown };
}

/** `host` or `host:port` (port 80 left out): the key of a Slide in /data and in the statuses. */
export const addressKey = (address) =>
  address ? (address.port === 80 ? address.host : `${address.host}:${address.port}`) : '';

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const bounded = (value, { default: fallback, min, max }) => {
  const number = numberOf(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.round(number)));
};

/** No control character, no space, not too long: what a device code may hold. */
const validCode = (code) =>
  code.length <= LIMITS.code &&
  [...code].every((c) => c.codePointAt(0) > 0x20 && c.codePointAt(0) !== 0x7f);

/** A list typed in a form: comma (or semicolon) separated, entries trimmed, empties kept. */
const splitList = (text) => (text.trim() === '' ? [] : text.split(/[,;]/).map((s) => s.trim()));

/**
 * @returns {{
 *   slides: { key: string, address: { host: string, port: number }, code: string }[],
 *   invalid: string[], dropped: number, local: boolean, credentialsInHost: boolean,
 *   badCodes: boolean, pollInterval: number, allowCalibration: boolean,
 *   language: 'fr'|'en' }}
 *   `code` is '' when none was typed for that Slide (API v2).
 */
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...OPTIONAL };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const addresses = splitList(typeof c.slides === 'string' ? c.slides : '');
  // The codes as `address=code` pairs: matched by address, never by position
  // (the secret field is never shown again: an order would shift unseen).
  const codes = new Map();
  let badCodes = false;
  for (const entry of splitList(typeof c.device_codes === 'string' ? c.device_codes : '')) {
    if (entry === '') {
      continue;
    }
    const at = entry.lastIndexOf('=');
    const parsed = at > 0 ? parseHost(entry.slice(0, at)) : {};
    const code = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!parsed.address || code === '' || !validCode(code)) {
      badCodes = true;
      continue;
    }
    const key = addressKey(parsed.address);
    if (codes.has(key) && codes.get(key) !== code) {
      // Two codes for one address: neither is sent.
      codes.set(key, '');
      badCodes = true;
      continue;
    }
    codes.set(key, code);
  }
  const slides = [];
  const invalid = [];
  let dropped = 0;
  let local = false;
  let credentialsInHost = false;
  addresses.forEach((text) => {
    if (text === '') {
      return;
    }
    const parsed = parseHost(text);
    if (parsed.credentials) {
      credentialsInHost = true;
      return;
    }
    if (!parsed.address) {
      local ||= Boolean(parsed.local);
      invalid.push(parsed.invalid ?? text.slice(0, 60));
      return;
    }
    const key = addressKey(parsed.address);
    if (slides.some((s) => s.key === key)) {
      return;
    }
    if (slides.length >= MAX_SLIDES) {
      dropped += 1;
      return;
    }
    slides.push({ key, address: parsed.address, code: codes.get(key) ?? '' });
  });
  return {
    slides,
    invalid,
    dropped,
    local,
    credentialsInHost,
    badCodes,
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    allowCalibration: strictTrue(c.allow_calibration),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What the reads depend on: a change of any of these starts over (compared in memory only). */
export const connectionKey = (config) => JSON.stringify(config.slides.map((s) => [s.key, s.code]));
