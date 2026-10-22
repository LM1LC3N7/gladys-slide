// -----------------------------------------------------------------------------
// The only network access of the integration: one plain HTTP POST to a Slide
// on node:http (its local API has no TLS). A deadline for the whole exchange,
// a size cap on the body (one buffer allocated once, filled in place), no
// redirect followed, no keep-alive, no User-Agent. Resolves
// { status, headers, body } for any status; rejects a SlideError for the
// transport failures, with `sent` true as soon as the request was written to
// a connected socket (it may then have reached the Slide).
// `sendWithin`: the connection must be up within this many ms, else nothing is
// written (a command never leaves late). `beforeSend`: the last check of a
// command, once connected, right before the first byte is written.
// The Authorization header is never logged, never put in an error.
// Adapted from LM1LC3N7/gladys-ismartgate (same author, Apache-2.0).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { SlideError } from './errors.js';

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  // Something answered, but not in HTTP (a wrong port).
  if (code.startsWith('HPE_')) {
    return new SlideError('invalid', { sent });
  }
  // Only our own words: a system message may carry an address.
  return new SlideError('unreachable', { sent });
}

/**
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path
 * @param {string} [options.body] JSON text, or nothing
 * @param {string} [options.authorization] the Digest answer, if any
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.beforeSend] if it throws, nothing is sent and
 *   its error is passed on with `beforeSend` set
 */
export function httpPost({
  host,
  port,
  path,
  body,
  authorization,
  timeout,
  sendWithin,
  maxBytes,
  beforeSend,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    // Until the request is written to a connected socket, nothing has left.
    let connected = false;
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(body, 'utf8');

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () => finish(new SlideError('timeout', { sent: connected })),
      Math.max(0, timeout),
    );
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(
            () => {
              if (!connected) {
                finish(new SlideError('late'));
              }
            },
            Math.max(0, sendWithin),
          );
    const markConnected = () => {
      if (connected || settled) {
        return;
      }
      clearTimeout(sendTimer);
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          err.beforeSend = true;
          err.sent = false;
          finish(err);
          return;
        }
      }
      connected = true;
      req.end(payload);
    };

    try {
      const headers = {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(payload.length),
        host: port === 80 ? host : `${host}:${port}`,
        connection: 'close',
      };
      if (authorization) {
        headers.authorization = authorization;
      }
      req = http.request({ method: 'POST', host, port, path, agent: false, headers });
      req.on('response', (res) => {
        const buffer = Buffer.allocUnsafe(maxBytes);
        let size = 0;
        res.on('data', (chunk) => {
          if (size + chunk.length > maxBytes) {
            finish(new SlideError('tooLarge', { sent: true }));
            return;
          }
          chunk.copy(buffer, size);
          size += chunk.length;
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: buffer.subarray(0, size),
          }),
        );
        res.on('error', (err) => finish(transportError(err, true)));
      });
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          markConnected();
        } else {
          socket.once('connect', markConnected);
        }
      });
      req.on('error', (err) => finish(transportError(err, connected)));
    } catch (err) {
      // http.request throws on a header it refuses: a failure, never a crash.
      finish(transportError(err, false));
    }
  });
}
