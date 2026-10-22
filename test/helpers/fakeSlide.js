// -----------------------------------------------------------------------------
// Fake Slides behind the `request` of the client (no network): each address
// answers like a Slide on API v2 (no authentication) or v1 (a Digest
// challenge, the device code checked), with GetInfo, SetPos, Stop and
// Calibrate. Failures are queued per address; every request is recorded
// (without the Authorization header).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { SlideError } from '../../src/slide/errors.js';

export const MAC_A = '300000000001';
export const MAC_B = '300000000002';
export const CODE = 'ABCD1234';

export function fakeClock(start = Date.UTC(2026, 9, 22, 10, 0, 0)) {
  let time = start;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

const md5 = (text) => createHash('md5').update(text).digest('hex');

/** A JSON answer. */
const json = (status, value, headers = {}) => ({
  status,
  headers,
  body: Buffer.from(value === undefined ? '' : JSON.stringify(value)),
});

/**
 * @param {Record<string, { mac?: string, slideId?: string, pos?: number, version?: 1|2,
 *   code?: string, name?: string, zone?: string }>} slides by address key
 */
export function fakeSlides(slides) {
  const state = new Map(
    Object.entries(slides).map(([address, s]) => [
      address,
      { version: 2, pos: 0.5, name: 'Salon', zone: '', ...s },
    ]),
  );
  const failures = new Map();
  const requests = [];
  let nonce = 0;
  /** Requests whose answer is held until release() (to see what waits behind them). */
  const held = [];
  let hold = false;

  function verify(slide, req) {
    const auth = req.authorization ?? '';
    const field = (name) => new RegExp(`${name}="?([^",]+)"?`).exec(auth)?.[1];
    const ha1 = md5(`user:Slide:${slide.code}`);
    const ha2 = md5(`POST:${req.path}`);
    const expected = md5(`${ha1}:${field('nonce')}:${field('nc')}:${field('cnonce')}:auth:${ha2}`);
    return field('response') === expected && field('uri') === req.path;
  }

  function answer(address, slide, req) {
    if (slide.version === 1) {
      if (!req.authorization) {
        nonce += 1;
        return json(401, undefined, {
          'www-authenticate': `Digest realm="Slide", qop="auth", nonce="n${nonce}", algorithm=MD5`,
        });
      }
      if (!verify(slide, req)) {
        return json(401, undefined, {
          'www-authenticate': `Digest realm="Slide", qop="auth", nonce="x", algorithm=MD5`,
        });
      }
    }
    switch (req.path) {
      case '/rpc/Slide.GetInfo':
        return json(200, {
          slide_id: slide.slideId ?? (slide.mac ? `slide_${slide.mac}` : undefined),
          mac: slide.mac,
          board_rev: 1,
          device_name: slide.name,
          zone_name: slide.zone,
          curtain_type: 0,
          calib_time: 10239,
          pos: slide.pos,
          touch_go: true,
        });
      case '/rpc/Slide.SetPos': {
        const pos = JSON.parse(req.body).pos;
        slide.asked = pos;
        if (slide.moveAtOnce !== false) {
          slide.pos = pos;
        }
        return json(200, { response: 'success' });
      }
      case '/rpc/Slide.Stop':
        slide.stopped = (slide.stopped ?? 0) + 1;
        return json(200, { response: 'success' });
      case '/rpc/Slide.Calibrate':
        slide.calibrated = (slide.calibrated ?? 0) + 1;
        return json(200, { response: 'success' });
      default:
        return json(404, undefined);
    }
  }

  async function request(req) {
    const address = req.port === 80 ? req.host : `${req.host}:${req.port}`;
    const slide = state.get(address);
    const queued = failures.get(address) ?? [];
    const failure = queued.shift();
    if (failure?.before) {
      // Fails before the connection: nothing written.
      throw new SlideError(failure.before, { sent: false });
    }
    // Connected: the last check of a command, right before the first byte.
    req.beforeSend?.();
    const record = { address, path: req.path, body: req.body, auth: Boolean(req.authorization) };
    requests.push(record);
    if (hold) {
      await new Promise((resolve) => held.push(resolve));
    }
    if (failure?.after) {
      throw new SlideError(failure.after, { sent: true });
    }
    if (failure?.status) {
      return json(failure.status, undefined, failure.headers ?? {});
    }
    if (failure?.body !== undefined) {
      return { status: 200, headers: {}, body: Buffer.from(failure.body) };
    }
    if (!slide) {
      throw new SlideError('unreachable', { sent: false });
    }
    return answer(address, slide, req);
  }

  return {
    request,
    requests,
    slide: (address) => state.get(address),
    set(address, values) {
      Object.assign(state.get(address), values);
    },
    remove(address) {
      state.delete(address);
    },
    add(address, values) {
      state.set(address, { version: 2, pos: 0.5, name: 'Salon', zone: '', ...values });
    },
    /** Queues failures for an address: { before }, { after }, { status, headers }, { body }. */
    fail(address, ...list) {
      failures.set(address, [...(failures.get(address) ?? []), ...list]);
    },
    holdAll(on = true) {
      hold = on;
    },
    release() {
      for (const resolve of held.splice(0)) {
        resolve();
      }
    },
    paths: (address) => requests.filter((r) => r.address === address).map((r) => r.path),
    clear() {
      requests.length = 0;
    },
  };
}
