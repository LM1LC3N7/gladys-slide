// -----------------------------------------------------------------------------
// The HTTP layer and the client against a real HTTP server on 127.0.0.1 (a
// simulated Slide, never the network): the POST and its body, API v1 with a
// real Digest exchange, the size cap, beforeSend, timeouts, a closed port.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { SlideClient } from '../src/slide/client.js';
import { httpPost } from '../src/slide/http.js';

const md5 = (text) => createHash('md5').update(text).digest('hex');

/** A simulated Slide: API v1 when `code` is given, v2 otherwise. */
async function server(t, { code, handler } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      if (handler) {
        handler(req, res, body);
        return;
      }
      if (code) {
        const auth = req.headers.authorization ?? '';
        const field = (n) => new RegExp(`${n}="?([^",]+)"?`).exec(auth)?.[1];
        const ha1 = md5(`user:Slide:${code}`);
        const ha2 = md5(`POST:${req.url}`);
        const ok =
          field('response') ===
          md5(`${ha1}:${field('nonce')}:${field('nc')}:${field('cnonce')}:auth:${ha2}`);
        if (!ok) {
          res.writeHead(401, {
            'www-authenticate': 'Digest realm="Slide", qop="auth", nonce="abc123", algorithm=MD5',
          });
          res.end();
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mac: '300000000000', pos: 0.5, echo: body }));
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  return { port: srv.address().port, seen };
}

const target = (port, code = '') => ({ address: { host: '127.0.0.1', port }, code });

test('API v2: one POST with its JSON body, no User-Agent, no keep-alive', async (t) => {
  const { port, seen } = await server(t);
  const client = new SlideClient();
  await client.setPos(target(port), 0.25, { timeout: 2000 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/rpc/Slide.SetPos');
  assert.deepEqual(JSON.parse(seen[0].body), { pos: 0.25 });
  assert.equal(seen[0].headers['user-agent'], undefined);
  assert.equal(seen[0].headers.connection, 'close');
  const info = await client.info(target(port), { timeout: 2000 });
  assert.equal(info.mac, '300000000000');
});

test('API v1: the Digest exchange with the device code; a wrong code is refused', async (t) => {
  const { port, seen } = await server(t, { code: 'ABCD1234' });
  const client = new SlideClient();
  const info = await client.info(target(port, 'ABCD1234'), { timeout: 2000 });
  assert.equal(info.pos, 0.5);
  assert.equal(seen.length, 2);
  assert.match(seen[1].headers.authorization, /^Digest username="user"/);
  assert.ok(!seen[1].headers.authorization.includes('ABCD1234'));
  await assert.rejects(client.info(target(port, 'WRONG'), { timeout: 2000 }), {
    kind: 'auth',
    answered: true,
  });
  await assert.rejects(client.info(target(port), { timeout: 2000 }), { kind: 'codeNeeded' });
});

test('an answer over the size cap is refused, without reading it all', async (t) => {
  const { port } = await server(t, {
    handler: (_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(100_000));
    },
  });
  await assert.rejects(new SlideClient().info(target(port), { timeout: 2000 }), {
    kind: 'tooLarge',
    sent: true,
  });
});

test('beforeSend refusing: nothing reaches the Slide', async (t) => {
  const { port, seen } = await server(t);
  const refusal = new Error('too late');
  await assert.rejects(
    new SlideClient().setPos(target(port), 0, {
      timeout: 2000,
      beforeSend: () => {
        throw refusal;
      },
    }),
    (err) => err === refusal && err.beforeSend === true && err.sent === false,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seen.length, 0);
});

test('a silent Slide: a timeout, sent; a closed port: unreachable, not sent', async (t) => {
  const { port } = await server(t, { handler: () => {} });
  await assert.rejects(
    httpPost({ host: '127.0.0.1', port, path: '/', timeout: 200, maxBytes: 100 }),
    {
      kind: 'timeout',
      sent: true,
    },
  );
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const freePort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    httpPost({ host: '127.0.0.1', port: freePort, path: '/', timeout: 2000, maxBytes: 100 }),
    { kind: 'unreachable', sent: false },
  );
});

test('HTTP statuses: 429 and 4xx answered, 5xx maybe done, not JSON', async (t) => {
  let status = 429;
  const { port } = await server(t, {
    handler: (_req, res) => {
      res.writeHead(status, { 'retry-after': '120' });
      res.end(status === 200 ? '<html>' : '');
    },
  });
  const client = new SlideClient();
  const call = () => client.stop(target(port), { timeout: 2000 });
  await assert.rejects(call(), { kind: 'rate', answered: true, retryAfter: 120_000 });
  status = 404;
  await assert.rejects(call(), { kind: 'http', answered: true });
  status = 500;
  await assert.rejects(call(), { kind: 'server', sent: true });
  status = 200;
  await assert.rejects(call(), { kind: 'format', sent: true });
});
