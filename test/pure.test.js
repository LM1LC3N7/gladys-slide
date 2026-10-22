// -----------------------------------------------------------------------------
// The pure parts: configuration, Digest, answers of the Slide, ids, the state
// kept in /data, the lane and the publisher budget.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { connectionKey, normalizeConfig, parseHost } from '../src/config.js';
import { MAX_SLIDES, TIMINGS } from '../src/constants.js';
import {
  identityOf,
  infoOf,
  parseExternalId,
  positionOf,
  slidePosFor,
  slidePosOf,
} from '../src/devices.js';
import { Lane, PRIORITY } from '../src/lane.js';
import { StatePublisher } from '../src/publisher.js';
import { digestHeader, parseChallenge } from '../src/slide/digest.js';
import { retryAfterOf } from '../src/slide/errors.js';
import { fingerprintOf, normalizeMemory } from '../src/store.js';

test('addresses: IPv4, names, ports; URLs reduced; credentials, https and .local refused', () => {
  assert.deepEqual(parseHost('192.168.1.40'), { address: { host: '192.168.1.40', port: 80 } });
  assert.deepEqual(parseHost(' http://192.168.1.40/rpc/Slide.GetInfo '), {
    address: { host: '192.168.1.40', port: 80 },
  });
  assert.deepEqual(parseHost('slide-salon:8080'), {
    address: { host: 'slide-salon', port: 8080 },
  });
  assert.deepEqual(parseHost('user:pw@192.168.1.40'), { credentials: true });
  assert.ok(parseHost('https://192.168.1.40').invalid);
  assert.equal(parseHost('slide.local').local, true);
  assert.ok(parseHost('999.1.1.1').invalid);
  assert.ok(parseHost('1.2.3.4:70000').invalid);
  assert.deepEqual(parseHost(''), {});
});

test('review I2: the codes are address=code pairs, matched by address, never by order', () => {
  const config = normalizeConfig({
    slides: '192.168.1.40, 192.168.1.41 ;192.168.1.42',
    device_codes: ' http://192.168.1.41=ABCD1234, 10.9.9.9=ZZZZ0000',
  });
  assert.deepEqual(
    config.slides.map((s) => [s.key, s.code]),
    [
      ['192.168.1.40', ''],
      ['192.168.1.41', 'ABCD1234'],
      ['192.168.1.42', ''],
    ],
  );
  assert.equal(config.badCodes, false);
  // An address removed, the codes left as they are: B keeps its own code.
  const removed = normalizeConfig({
    slides: '192.168.1.41',
    device_codes: '192.168.1.40=AAAA1111, 192.168.1.41=BBBB2222',
  });
  assert.deepEqual(removed.slides[0].code, 'BBBB2222');
  for (const codes of [
    'AAAA1111, BBBB2222', // the old format, by order: refused
    `1.1.1.1=AB\u0007CD`,
    '1.1.1.1=',
    '1.1.1.1=AAAA1111, 1.1.1.1=BBBB2222', // two codes for one address
  ]) {
    const bad = normalizeConfig({ slides: '1.1.1.1', device_codes: codes });
    assert.equal(bad.badCodes, true, codes);
    assert.equal(bad.slides[0].code, '', codes);
  }
  const many = normalizeConfig({
    slides: Array.from({ length: 10 }, (_, i) => `10.0.0.${i + 1}`).join(','),
  });
  assert.equal(many.slides.length, MAX_SLIDES);
  assert.equal(many.dropped, 2);
  const dup = normalizeConfig({ slides: '10.0.0.1, 10.0.0.1:80' });
  assert.equal(dup.slides.length, 1);
});

test('the options: bounded interval, calibration only on a true, language', () => {
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: '99999' }).pollInterval, 3600);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 30);
  assert.equal(normalizeConfig({ allow_calibration: 'yes' }).allowCalibration, false);
  assert.equal(normalizeConfig({ allow_calibration: true }).allowCalibration, true);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.notEqual(
    connectionKey(normalizeConfig({ slides: '1.1.1.1', device_codes: '1.1.1.1=A' })),
    connectionKey(normalizeConfig({ slides: '1.1.1.1', device_codes: '1.1.1.1=B' })),
  );
  assert.equal(
    connectionKey(normalizeConfig({ slides: '1.1.1.1', poll_interval: 10 })),
    connectionKey(normalizeConfig({ slides: '1.1.1.1', poll_interval: 60 })),
  );
});

test('Digest: the RFC 2617 example, and challenges we do not answer', () => {
  const challenge = parseChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  );
  assert.ok(challenge);
  const header = digestHeader({
    username: 'Mufasa',
    password: 'Circle Of Life',
    method: 'GET',
    uri: '/dir/index.html',
    challenge,
    cnonce: '0a4f113b',
  });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  assert.equal(parseChallenge('Basic realm="x"'), undefined);
  assert.equal(parseChallenge('Digest realm="x", qop="auth"'), undefined, 'no nonce');
  assert.equal(parseChallenge('Digest nonce="a", qop="auth-int"'), undefined, 'no qop auth');
  assert.equal(parseChallenge('Digest nonce="a", qop="auth", algorithm=SHA-256'), undefined);
  assert.equal(parseChallenge('Digest nonce="a\\"b", qop="auth"'), undefined, 'escapes');
  assert.equal(parseChallenge(`Digest nonce="${'a'.repeat(2000)}", qop="auth"`), undefined);
  assert.equal(parseChallenge('Digest nonce="a\r\nX: y", qop="auth"'), undefined, 'CR LF');
  const linear = `Digest ${'a=b,'.repeat(200)}nonce="n", qop="auth"`;
  assert.ok(parseChallenge(linear));
  assert.ok(parseChallenge(['Digest nonce="n", qop=auth']));
});

test('Retry-After: seconds or a date, bounded input', () => {
  assert.equal(retryAfterOf('120'), 120_000);
  assert.equal(retryAfterOf('x'.repeat(100)), undefined);
  assert.equal(retryAfterOf(undefined), undefined);
  const now = Date.UTC(2026, 0, 1);
  assert.equal(retryAfterOf('Thu, 01 Jan 2026 00:01:00 GMT', now), 60_000);
});

test('the answers of GetInfo: identity, position, texts', () => {
  assert.equal(identityOf({ mac: '30:00:00:00:00:0A' }), '30000000000a');
  assert.equal(identityOf({ slide_id: 'slide_300000000000' }), '300000000000');
  assert.equal(identityOf({ mac: 'zz', slide_id: 42 }), undefined);
  assert.equal(identityOf(null), undefined);
  assert.equal(slidePosOf({ pos: 1.02 }), 1);
  assert.equal(slidePosOf({ pos: -0.01 }), 0);
  assert.equal(slidePosOf({ pos: 127.5 }), undefined);
  assert.equal(slidePosOf({ pos: '0.5' }), undefined);
  assert.equal(positionOf(0), 100, 'pos 0 = open');
  assert.equal(positionOf(1), 0, 'pos 1 = closed');
  assert.equal(slidePosFor(100), 0);
  assert.equal(slidePosFor(25), 0.75);
  const info = infoOf({
    mac: '300000000000',
    device_name: 'Sa\u0000lon ',
    zone_name: 'x'.repeat(500),
    pos: 0.4,
    __proto__: { polluted: true },
  });
  assert.equal(info.name, 'Salon');
  assert.equal(info.zone.length, 60);
  assert.equal(info.position, 60);
  assert.equal({}.polluted, undefined);
  const parsed = JSON.parse('{"__proto__": {"polluted": true}, "mac": "300000000000"}');
  assert.equal(infoOf(parsed).id, '300000000000');
  assert.equal({}.polluted, undefined);
});

test('external ids: only ours, a MAC and one key', () => {
  const gladys = createFakeGladys({ selector: 'slide' });
  assert.deepEqual(parseExternalId(gladys, 'ext:slide:slide:300000000000:position'), {
    id: '300000000000',
    key: 'position',
  });
  assert.deepEqual(parseExternalId(gladys, 'ext:slide:slide:300000000000'), {
    id: '300000000000',
    key: undefined,
  });
  assert.equal(parseExternalId(gladys, 'ext:other:slide:300000000000'), undefined);
  assert.equal(parseExternalId(gladys, 'ext:slide:slide:xyz:position'), undefined);
  assert.equal(parseExternalId(gladys, 'ext:slide:slide:300000000000:a:b'), undefined);
  assert.equal(parseExternalId(gladys, 42), undefined);
});

test('the state kept in /data: repaired, bounded, never a code', () => {
  const now = Date.UTC(2026, 9, 22);
  const memory = normalizeMemory(
    {
      salt: 'bad',
      lastAttemptAt: now + 1e9,
      pauses: [
        { address: '1.1.1.1', until: now + 1e12, failures: 3 },
        { address: '1.1.1.1', until: now + 5000 },
        { address: '2.2.2.2', until: now - 1 },
      ],
      blocks: [{ address: '1.1.1.1', fp: 'f'.repeat(32), kind: 'auth', failures: 2 }, 'x'],
      slides: [
        { address: '1.1.1.1', id: 'ZZ' },
        { address: '1.1.1.1', id: '300000000000' },
      ],
    },
    now,
  );
  assert.match(memory.salt, /^[0-9a-f]{32}$/);
  assert.equal(memory.lastAttemptAt, now);
  assert.deepEqual(memory.pauses, [
    { address: '1.1.1.1', until: now + TIMINGS.pauseMax, failures: 3 },
  ]);
  assert.equal(memory.blocks.length, 1);
  assert.deepEqual(memory.slides, [{ address: '1.1.1.1', id: '300000000000', readAt: 0 }]);
  const fp = fingerprintOf(memory.salt, '1.1.1.1', 'ABCD1234');
  assert.match(fp, /^[0-9a-f]{32}$/);
  assert.ok(!fp.includes('ABCD1234'));
  assert.deepEqual(normalizeMemory('garbage', now).pauses, []);
});

test('the lane: one task at a time, the commands before the reads', async () => {
  const lane = new Lane();
  const order = [];
  let release;
  const first = lane.run(PRIORITY.read, () => new Promise((r) => (release = r)));
  const read = lane.run(PRIORITY.read, () => order.push('read'));
  const command = lane.run(PRIORITY.command, () => order.push('command'));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, read, command]);
  assert.deepEqual(order, ['command', 'read']);
  await assert.rejects(
    lane.run(PRIORITY.read, () => {
      throw new Error('boom');
    }),
  );
  assert.equal(await lane.run(PRIORITY.read, () => 7), 7, 'a failure never blocks the lane');
});

test('the publisher stays within the budget, even with flushes at the same time', async () => {
  const sent = [];
  const gladys = {
    publishChangedStates: async (batch) => {
      sent.push(...batch);
      return { count: batch.length };
    },
  };
  const publisher = new StatePublisher({ gladys, logger: console, budget: 3 });
  for (let i = 0; i < 5; i += 1) {
    publisher.push(`f${i}`, { state: i });
  }
  await Promise.all([publisher.flush(), publisher.doFlush()]);
  assert.equal(sent.length, 3);
});
