// -----------------------------------------------------------------------------
// The scenarios of review 1, inverted: each one now checks the fix (B1, I1-I4,
// M1-M7). Same harness as test/app.test.js: the SDK's fake Gladys, fake
// Slides behind the client's `request`, a fake clock, recorded timers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SlideApp } from '../src/app.js';
import { SECOND, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { SlideClient } from '../src/slide/client.js';
import { memoryStore } from '../src/store.js';
import { MAC_A, MAC_B, fakeClock, fakeSlides } from './helpers/fakeSlide.js';

const SELECTOR = 'slide';
const A = '192.168.1.40';
const B = '192.168.1.41';
const id = (mac, key) => `ext:${SELECTOR}:slide:${mac}${key ? `:${key}` : ''}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function setup(
  t,
  {
    config = { slides: A },
    clock = fakeClock(),
    slides,
    request,
    store = memoryStore(),
    read = true,
  } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: [] });
  const timeouts = [];
  const timers = {
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms, at: clock.now() });
      return timeouts.length;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const app = new SlideApp({
    gladys,
    logger: quiet,
    client: new SlideClient({ request: request ?? slides.request, now: clock.now }),
    store,
    now: clock.now,
    timers,
  });
  registerHandlers(gladys, app, quiet);
  await gladys.connect();
  if (read) {
    await app.tick({ scheduled: true });
  }
  t.after(() => app.stop());
  return { gladys, app, clock, timeouts, store };
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

function press(gladys, mac, key, value) {
  const device =
    gladys.fake.discoveredDevices.find((d) => d.external_id === id(mac)) ??
    gladys.fake.devices.find((d) => d.external_id === id(mac));
  return gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id.endsWith(`:${key}`)),
    value,
  );
}

/** Runs the next scheduled cycles as their timers would, returns their delays. */
async function cycles(app, timeouts, clock, count) {
  const delays = [];
  for (let i = 0; i < count; i += 1) {
    const timer = timeouts.at(-1);
    delays.push(timer.ms);
    clock.advance(timer.ms);
    timer.fn();
    await flush();
    await flush();
  }
  return delays;
}

test('B1: a blocked Slide never makes a cycle loop at 0 ms', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A, version: 1, code: 'GOOD1234' } });
  const { app, clock, timeouts } = await setup(t, {
    config: { slides: A, device_codes: `${A}=WRONG123` },
    slides,
  });
  assert.ok(app.blockOf(app.slots.get(A)));
  slides.clear();
  clock.advance(31_000);
  const delays = await cycles(app, timeouts, clock, 10);
  assert.ok(
    delays.slice(1).every((d) => d >= 30_000),
    `all blocked: an interval each time (${delays})`,
  );
  assert.equal(slides.requests.length, 0);
});

test('B1: a Slide paused or waiting for its next try: the next cycle at its end', async (t) => {
  const slides = fakeSlides({});
  const { app, clock, timeouts } = await setup(t, { slides });
  const slot = app.slots.get(A);
  slot.failures = 3;
  slot.nextRetryAt = clock.now() + 5 * 60_000;
  clock.advance(31_000);
  const [first, ...next] = await cycles(app, timeouts, clock, 3);
  assert.ok(first >= 0);
  for (const d of next) {
    assert.ok(d >= SECOND, `never at 0 ms: ${d}`);
  }
  assert.ok(next[0] >= 5 * 60_000 - 31_000 - first, `waits for the next try: ${next[0]}`);
  // A pause: the next cycle at its end.
  await app.pause(slot, { kind: 'rate', retryAfter: 2 * 3600_000 });
  app.schedule();
  assert.equal(timeouts.at(-1).ms, 2 * 3600_000);
});

test('I1: on API v1, a STOP during the Digest challenge cancels the move', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A, version: 1, code: 'ABCD1234', pos: 0.5 } });
  let gate;
  const order = [];
  const request = async (req) => {
    if (req.path === '/rpc/Slide.SetPos' && !req.authorization && !gate) {
      const res = await slides.request(req);
      await new Promise((r) => {
        gate = r;
      });
      return res;
    }
    const res = await slides.request(req);
    order.push(`${req.path}${req.authorization ? '+auth' : ''}:${res.status}`);
    return res;
  };
  const { gladys } = await setup(t, {
    config: { slides: A, device_codes: `${A}=ABCD1234` },
    slides,
    request,
  });
  await createAll(gladys);
  order.length = 0;
  const move = press(gladys, MAC_A, 'state', 1);
  for (let i = 0; i < 10 && !gate; i += 1) await flush();
  assert.ok(gate);
  const stop = await press(gladys, MAC_A, 'state', 0);
  assert.equal(stop.success, true, stop.error);
  gate();
  const moved = await move;
  assert.equal(moved.success, false);
  assert.match(moved.error, /arrêt de ce Slide est arrivé/);
  assert.ok(!order.includes('/rpc/Slide.SetPos+auth:200'), order.join(' | '));
  assert.equal(slides.slide(A).pos, 0.5, 'the curtain never moved');
});

test('I2: an address removed, codes left: the code of A never goes to B', async (t) => {
  const slides = fakeSlides({
    [A]: { mac: MAC_A, version: 1, code: 'AAAA1111' },
    [B]: { mac: MAC_B, version: 1, code: 'BBBB2222' },
  });
  const codes = `${A}=AAAA1111, ${B}=BBBB2222`;
  const { app, gladys } = await setup(t, {
    config: { slides: `${A}, ${B}`, device_codes: codes },
    slides,
  });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await gladys.fake.configUpdated({ slides: B, device_codes: codes });
  await app.tick({ scheduled: true });
  assert.equal(app.blockOf(app.slots.get(B)), undefined);
  assert.equal(app.slots.get(B).online, true);
  // The old format (by order) sends no code at all, and says so.
  await gladys.fake.configUpdated({ slides: B, device_codes: 'AAAA1111, BBBB2222' });
  assert.equal(app.slots.get(B).code, '');
  assert.match(gladys.fake.connectionStatus.message.en, /not an address=code pair/);
});

test('I3: a move answered after a configuration change: nothing of the old one', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A }, [B]: { mac: MAC_B } });
  let gate;
  const request = async (req) => {
    if (req.path === '/rpc/Slide.SetPos' && !gate) {
      req.beforeSend?.();
      await new Promise((r) => {
        gate = r;
      });
      return slides.request({ ...req, beforeSend: undefined });
    }
    return slides.request(req);
  };
  const { app, gladys, timeouts, clock, store } = await setup(t, {
    config: { slides: `${A}, ${B}` },
    slides,
    request,
  });
  await createAll(gladys);
  const move = press(gladys, MAC_A, 'state', -1);
  for (let i = 0; i < 10 && !gate; i += 1) await flush();
  assert.ok(gate);
  await app.configUpdated({ slides: B });
  timeouts.length = 0;
  gate();
  await move;
  await flush();
  slides.clear();
  for (const f of timeouts.filter((x) => TIMINGS.followUps.includes(x.ms))) {
    clock.advance(f.ms);
    f.fn();
    await flush();
    await flush();
  }
  assert.deepEqual(slides.paths(A), [], 'a removed address is never read again');
  assert.ok(!store.data.slides.some((s) => s.address === A));
});

test('I4: the position of a Slide that no longer answers is not published again', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A, pos: 0.25 } });
  const { app, gladys, clock } = await setup(t, { slides });
  await createAll(gladys);
  await flush();
  const feature = id(MAC_A, 'position');
  const count = () =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === feature).length;
  const before = count();
  slides.remove(A);
  clock.advance(31_000);
  await app.tick({ scheduled: true });
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 60_000;
  try {
    await app.publishAll();
    await flush();
  } finally {
    Date.now = realNow;
  }
  assert.equal(count(), before);
  // A read too old (a Slide not read for a long time) is not pushed either.
  slides.add(A, { mac: MAC_A, pos: 0.25 });
  clock.advance(31_000);
  await app.tick({ scheduled: true });
  app.slots.get(A).readAt = clock.now() - 10 * 60_000;
  app.publisher.pending.clear();
  app.queueStates();
  assert.equal(app.publisher.pending.size, 0);
});

test('M1: STOP is accepted while a configuration change starts', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A } });
  const inner = memoryStore();
  let hold;
  const store = {
    load: () => inner.load(),
    save: async (data) => {
      if (hold) {
        await hold;
      }
      return inner.save(data);
    },
    get data() {
      return inner.data;
    },
  };
  const { app, gladys } = await setup(t, { slides, store, config: { slides: `${A}, ${B}` } });
  await createAll(gladys);
  let release;
  hold = new Promise((r) => {
    release = r;
  });
  const starting = app.configUpdated({ slides: A }); // B removed: tidyMemory saves
  await flush();
  const stop = await press(gladys, MAC_A, 'state', 0);
  assert.equal(stop.success, true, stop.error);
  release();
  hold = undefined;
  await starting;
});

test('M2: after a restart, connected from the last read kept in /data', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A } });
  const store = memoryStore();
  const clock = fakeClock();
  const first = await setup(t, { slides, store, clock });
  await first.app.stop();
  clock.advance(10_000);
  const second = await setup(t, { slides, store, clock, read: false });
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  // Long after: no longer taken as connected.
  await second.app.stop();
  clock.advance(3600_000);
  const third = await setup(t, { slides, store, clock, read: false });
  assert.equal(third.gladys.fake.connectionStatus.connected, false);
});

test('M3: a stale challenge is an ordinary failure, never a refused code', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A, version: 1, code: 'ABCD1234' } });
  // The probe answers normally (401 + challenge); the authenticated request
  // gets a new challenge marked stale.
  slides.fail(
    A,
    {},
    {
      status: 401,
      headers: {
        'www-authenticate': 'Digest realm="Slide", qop="auth", nonce="new", stale=true',
      },
    },
  );
  const request = async (req) => {
    if (!req.authorization) {
      return slides.request(req);
    }
    return slides.request(req);
  };
  const { app } = await setup(t, {
    config: { slides: A, device_codes: `${A}=ABCD1234` },
    slides,
    request,
  });
  const slot = app.slots.get(A);
  assert.equal(app.blockOf(slot), undefined);
  assert.equal(slot.error, 'stale');
  assert.ok(slot.nextRetryAt > 0);
});

test('M4: a 403 without any code sent is not a refused code', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A } });
  slides.fail(A, { status: 403 });
  const { app, gladys } = await setup(t, { slides });
  assert.equal(app.blockOf(app.slots.get(A)), undefined);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer like a Slide/);
});

test('M5: changing the code of one Slide reads only that one at once', async (t) => {
  const slides = fakeSlides({
    [A]: { mac: MAC_A },
    [B]: { mac: MAC_B, version: 1, code: 'BBBB2222' },
  });
  const { app, gladys, timeouts, clock } = await setup(t, {
    config: { slides: `${A}, ${B}`, device_codes: `${B}=WRONG000` },
    slides,
  });
  assert.ok(app.blockOf(app.slots.get(B)));
  slides.clear();
  clock.advance(5000);
  await gladys.fake.configUpdated({ slides: `${A}, ${B}`, device_codes: `${B}=BBBB2222` });
  const timer = timeouts.at(-1);
  assert.equal(timer.ms, 0, 'the changed Slide is due at once');
  timer.fn();
  await flush();
  await flush();
  await app.running;
  assert.deepEqual(slides.paths(A), [], 'the unchanged Slide waits for its interval');
  assert.ok(slides.paths(B).length > 0);
  assert.equal(app.blockOf(app.slots.get(B)), undefined);
});

test('M6: a refusal right before sending goes through the real beforeSend path', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A } });
  const { app, gladys } = await setup(t, {
    slides,
    config: { slides: A, allow_calibration: true },
  });
  await createAll(gladys);
  slides.holdAll();
  const pending = press(gladys, MAC_A, 'calibrate', 1);
  await flush();
  app.config = { ...app.config, allowCalibration: false };
  slides.holdAll(false);
  slides.release();
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /calibrage est désactivé/, 'the refusal itself, not "sent, unconfirmed"');
  assert.equal(app.unconfirmed.has(MAC_A), false);
});

test('M7: the notices give the version of setup.py at the commit used', () => {
  const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /5dac98b/);
  assert.match(notices, /`setup\.py` 0\.7\.3/);
  assert.doesNotMatch(notices, /0\.7\.4/);
});
