// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), so that a restart never asks a Slide again before its time nor
// loops on a refused code, and so that "Stop" works before the first read:
//   - `pauses`: per address, the end of a pause asked by the Slide (429, 5xx);
//   - `blocks`: per address, a device code refused (or missing on API v1),
//     with the salted fingerprint of the REFUSED code: final, never tried
//     again by itself; another code lifts it (even typed while the container
//     was stopped), the Test button tries once and lifts it on a success;
//   - `slides`: per address, the identity (MAC) of the Slide last read there;
//   - `lastAttemptAt`: when the Slides were last read (written at most once a
//     minute: src/app.js waits that minute more after a restart).
// NO SECRET: no device code, nor anything derived from a code a Slide
// accepted. The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { MAX_SLIDES, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/slide-state.json';

export function fileStore(path = process.env.DATA_FILE || STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 64 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** The salted fingerprint of a code a Slide REFUSED at an address (never of a good one). */
export const fingerprintOf = (salt, address, code) =>
  createHash('sha256').update(`${salt}:${address}:${code}`).digest('hex').slice(0, 32);

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => (Array.isArray(value) ? value.slice(0, MAX_SLIDES * 4) : []);
const address = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : '';
const count = (value, max) => (Number.isInteger(value) && value > 0 ? Math.min(value, max) : 1);

/** Keeps the first entry of each address, at most MAX_SLIDES * 4 of them. */
function byAddress(raw, read) {
  const out = [];
  for (const entry of list(raw)) {
    const value = read(object(entry));
    if (value && !out.some((o) => o.address === value.address)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * The persisted state, repaired and bounded: a pause never more than 6 h
 * away, a last attempt never in the future (a clock that jumped, a file
 * edited by hand).
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  return {
    salt:
      typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
        ? data.salt
        : randomBytes(16).toString('hex'),
    lastAttemptAt: Math.min(
      Math.max(0, Number.isFinite(data.lastAttemptAt) ? data.lastAttemptAt : 0),
      now,
    ),
    slides: byAddress(data.slides, (s) =>
      address(s.address) && typeof s.id === 'string' && /^[0-9a-f]{12}$/.test(s.id)
        ? { address: s.address, id: s.id }
        : undefined,
    ),
    pauses: byAddress(data.pauses, (p) =>
      address(p.address) && Number.isFinite(p.until) && p.until > now
        ? {
            address: p.address,
            until: Math.min(p.until, now + TIMINGS.pauseMax),
            failures: count(p.failures, 20),
          }
        : undefined,
    ),
    blocks: byAddress(data.blocks, (b) =>
      address(b.address) &&
      typeof b.fp === 'string' &&
      /^[0-9a-f]{32}$/.test(b.fp) &&
      (b.kind === 'auth' || b.kind === 'codeNeeded')
        ? { address: b.address, fp: b.fp, kind: b.kind, failures: count(b.failures, 100) }
        : undefined,
    ),
  };
}
