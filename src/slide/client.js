// -----------------------------------------------------------------------------
// The local API of one Slide: GetInfo, SetPos, Stop, Calibrate (ported from
// goslide-api `GoSlideLocal`, Apache-2.0). Every call is a POST to
// http://<slide>/rpc/<method>, first without authentication: a Slide on API v2
// answers it; a Slide on API v1 answers 401 with a Digest challenge (it did
// nothing), and the same request is sent again with the answer computed from
// the device code. One deadline covers both requests.
//
// Errors (src/slide/errors.js): `sent` true only when a request that could
// have had an effect left without a clear answer; `answered` true when the
// Slide answered with a refusal (401, 429, another 4xx, a redirect).
// -----------------------------------------------------------------------------

import { API, LIMITS } from '../constants.js';
import { digestHeader, parseChallenge } from './digest.js';
import { SlideError, retryAfterOf } from './errors.js';
import { httpPost } from './http.js';

const refused = (kind, status, extra = {}) => {
  const err = new SlideError(kind, { status, ...extra });
  err.answered = true;
  return err;
};

export class SlideClient {
  /**
   * @param {{ request?: typeof httpPost, now?: () => number }} [options]
   */
  constructor({ request = httpPost, now = Date.now } = {}) {
    this.request = request;
    this.now = now;
  }

  /** An answer of the Slide -> its JSON (null when empty), or the SlideError it carries. */
  answer(res, { authenticated = false } = {}) {
    const status = res.status;
    if (status === 429) {
      throw refused('rate', status, { retryAfter: retryAfterOf(res.headers?.['retry-after']) });
    }
    if (status >= 500) {
      // It may have done it before failing.
      throw new SlideError('server', {
        status,
        sent: true,
        retryAfter: retryAfterOf(res.headers?.['retry-after']),
      });
    }
    if (status === 401 || status === 403) {
      // A refusal of the code only when one was sent; otherwise something
      // else than a Slide answers (review M4).
      throw refused(authenticated ? 'auth' : 'http', status);
    }
    if (status < 200 || status >= 300) {
      throw refused('http', status);
    }
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '');
    if (text.trim() === '') {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new SlideError('format', { status, sent: true });
    }
  }

  /**
   * One call of the API.
   * @param {{ address: { host: string, port: number }, code: string }} target
   * @param {string} path
   * @param {string|undefined} body JSON text
   * @param {{ timeout: number, sendWithin?: number, beforeSend?: () => void,
   *   onChallenge?: () => void }} options
   *   `onChallenge`: the first request was answered 401 with a challenge, so
   *   it did nothing (a command may then still be cancelled before the second)
   */
  async call(target, path, body, { timeout, sendWithin, beforeSend, onChallenge }) {
    const start = this.now();
    const deadline = start + timeout;
    const sendBy = sendWithin === undefined ? undefined : start + sendWithin;
    const common = {
      host: target.address.host,
      port: target.address.port,
      path,
      body,
      maxBytes: LIMITS.responseBytes,
      beforeSend,
    };
    const first = await this.request({ ...common, timeout, sendWithin });
    if (first.status !== 401) {
      return this.answer(first);
    }
    // API v1: the Slide did nothing and asks for the device code.
    onChallenge?.();
    const challenge = parseChallenge(first.headers?.['www-authenticate']);
    if (!challenge) {
      throw refused('format', 401);
    }
    if (!target.code) {
      throw refused('codeNeeded', 401);
    }
    const left = deadline - this.now();
    if (left <= 0 || (sendBy !== undefined && sendBy - this.now() <= 0)) {
      throw new SlideError(sendBy !== undefined ? 'late' : 'timeout');
    }
    const authorization = digestHeader({
      username: API.user,
      password: target.code,
      method: 'POST',
      uri: path,
      challenge,
    });
    const second = await this.request({
      ...common,
      authorization,
      timeout: left,
      sendWithin: sendBy === undefined ? undefined : sendBy - this.now(),
    });
    if (second.status === 401) {
      // A new challenge marked stale: the nonce expired meanwhile, not the
      // code refused (review M3): an ordinary failure, tried at the interval.
      const again = parseChallenge(second.headers?.['www-authenticate']);
      throw refused(again?.get('stale')?.toLowerCase() === 'true' ? 'stale' : 'auth', 401);
    }
    return this.answer(second, { authenticated: true });
  }

  /** GetInfo: the identity, the name and the position of the Slide (an object). */
  async info(target, options) {
    const json = await this.call(target, API.info, undefined, options);
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new SlideError('format');
    }
    return json;
  }

  /** SetPos: 0 open .. 1 closed. */
  setPos(target, pos, options) {
    return this.call(target, API.setPos, JSON.stringify({ pos }), options);
  }

  stop(target, options) {
    return this.call(target, API.stop, undefined, options);
  }

  calibrate(target, options) {
    return this.call(target, API.calibrate, undefined, options);
  }
}
