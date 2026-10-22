// -----------------------------------------------------------------------------
// SlideApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), fake Slides behind the client's `request`, a fake clock
// and a memory store. No network; the timers are recorded, never fired by
// themselves.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SlideApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { SlideClient } from '../src/slide/client.js';
import { memoryStore } from '../src/store.js';
import { CODE, MAC_A, MAC_B, fakeClock, fakeSlides } from './helpers/fakeSlide.js';

const SELECTOR = 'slide';
const A = '192.168.1.40';
const B = '192.168.1.41';
const id = (mac, key) => `ext:${SELECTOR}:slide:${mac}${key ? `:${key}` : ''}`;

async function setup(
  t,
  {
    config = { slides: A },
    clock = fakeClock(),
    slides = fakeSlides({ [A]: { mac: MAC_A, pos: 0.25 } }),
    store = memoryStore(),
    devices = [],
    read = true,
  } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
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
    logger,
    client: new SlideClient({ request: slides.request, now: clock.now }),
    store,
    now: clock.now,
    timers,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  if (read) {
    // The first cycle, as the timer set by the start would run it.
    await app.tick({ scheduled: true });
  }
  t.after(() => app.stop());
  return { gladys, app, slides, logs, store, clock, timeouts };
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

const deviceOf = (gladys, mac) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(mac)) ??
  gladys.fake.devices.find((d) => d.external_id === id(mac));
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

function press(gladys, mac, key, value) {
  const device = deviceOf(gladys, mac);
  return gladys.fake.setValue(device, featureOf(device, key), value);
}

const status = (gladys) => gladys.fake.connectionStatus;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const reconnect = async (gladys) => {
  await gladys.disconnect();
  await gladys.connect();
};

/** Runs the follow-up reads planned after a command (the recorded timers). */
async function runFollowUps(timeouts, clock) {
  let elapsed = 0;
  for (const timer of timeouts.splice(0).filter((x) => TIMINGS.followUps.includes(x.ms))) {
    clock.advance(timer.ms - elapsed);
    elapsed = timer.ms;
    timer.fn();
    await flush();
    await flush();
  }
}

test('each Slide becomes a curtain of the Discovery tab, its position read', async (t) => {
  const { gladys } = await setup(t);
  const device = deviceOf(gladys, MAC_A);
  assert.equal(device.name, 'Salon');
  assert.deepEqual(
    device.features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type]),
    [
      ['state', 'curtain', 'state'],
      ['position', 'curtain', 'position'],
      ['calibrate', 'button', 'push'],
    ],
    'never a switch nor a binary',
  );
  assert.ok(device.features.every((f) => f.unit === undefined));
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /1 of 1 Slides answer/);
  assert.match(status(gladys).message.en, /75 % open/);
  assert.match(status(gladys).message.fr, /Calibrage désactivé/);
  await createAll(gladys);
  await flush();
  assert.equal(gladys.fake.lastState(id(MAC_A, 'position')), 75, 'pos 0.25 = 75 % open');
});

test('open, close and a position go after an identity read, as Slide positions', async (t) => {
  const { gladys, slides } = await setup(t);
  await createAll(gladys);
  slides.clear();
  let ack = await press(gladys, MAC_A, 'state', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(slides.paths(A), ['/rpc/Slide.GetInfo', '/rpc/Slide.SetPos']);
  assert.equal(slides.slide(A).asked, 0, 'open = pos 0');
  ack = await press(gladys, MAC_A, 'state', -1);
  assert.equal(ack.success, true);
  assert.equal(slides.slide(A).asked, 1, 'close = pos 1');
  ack = await press(gladys, MAC_A, 'position', 30);
  assert.equal(ack.success, true);
  assert.equal(slides.slide(A).asked, 0.7, 'Gladys 30 % open = pos 0.7');
  for (const bad of ['', null, true, 101, -1, 'abc']) {
    const refused = await press(gladys, MAC_A, 'position', bad);
    assert.equal(refused.success, false, String(bad));
  }
  assert.equal((await press(gladys, MAC_A, 'state', 2)).success, false);
});

test('a move is refused, unsent, when another Slide answers at the address', async (t) => {
  const { gladys, slides } = await setup(t);
  await createAll(gladys);
  slides.set(A, { mac: MAC_B });
  slides.clear();
  const ack = await press(gladys, MAC_A, 'state', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Un autre Slide répond/);
  assert.deepEqual(slides.paths(A), ['/rpc/Slide.GetInfo'], 'no SetPos');
});

test('an identity that cannot be read is not "another Slide", and no move leaves', async (t) => {
  const { gladys, slides, app } = await setup(t);
  await createAll(gladys);
  slides.set(A, { mac: undefined, slideId: undefined });
  slides.clear();
  const ack = await press(gladys, MAC_A, 'state', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /identité du Slide n'a pas pu être vérifiée/);
  assert.deepEqual(slides.paths(A), ['/rpc/Slide.GetInfo']);
  assert.equal(app.slotOf(MAC_A)?.key, A, 'the Slide is still known at its address');
});

test('the MAC address is read from slide_id when `mac` is missing', async (t) => {
  const slides = fakeSlides({ [A]: { slideId: `slide_${MAC_B}`, pos: 0 } });
  const { gladys } = await setup(t, { slides });
  assert.ok(deviceOf(gladys, MAC_B));
});

test('STOP goes at once, through a pause, and cancels the moves not sent yet', async (t) => {
  const { gladys, slides, app, clock } = await setup(t);
  await createAll(gladys);
  // A 429 pauses the Slide: moves are refused, STOP still goes (one try).
  await app.pause(app.slots.get(A), { kind: 'rate' });
  const refused = await press(gladys, MAC_A, 'state', 1);
  assert.equal(refused.success, false);
  assert.match(refused.error, /ralentir/);
  slides.clear();
  const ack = await press(gladys, MAC_A, 'state', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(slides.paths(A), ['/rpc/Slide.Stop'], 'no identity read before a STOP');
  clock.advance(TIMINGS.pauseMax);

  // A move held behind a slow read is cancelled by a STOP arriving meanwhile.
  slides.holdAll();
  const reading = app.readSlot(app.slots.get(A), app.generation);
  await flush();
  const move = press(gladys, MAC_A, 'state', 1);
  await flush();
  slides.holdAll(false);
  slides.clear();
  const stop = await press(gladys, MAC_A, 'state', 0);
  assert.equal(stop.success, true);
  slides.release();
  await reading;
  const moved = await move;
  assert.equal(moved.success, false);
  assert.match(moved.error, /arrêt de ce Slide est arrivé/);
  assert.ok(!slides.paths(A).includes('/rpc/Slide.SetPos'));
});

test('a move that was leaving when STOP came is followed by a second STOP', async (t) => {
  const { gladys, slides } = await setup(t);
  await createAll(gladys);
  slides.holdAll();
  const move = press(gladys, MAC_A, 'state', 1);
  await flush();
  slides.release(); // the identity read answers; the SetPos leaves and is held
  await flush();
  await flush();
  assert.equal(slides.requests.at(-1).path, '/rpc/Slide.SetPos');
  slides.holdAll(false);
  const stop = await press(gladys, MAC_A, 'state', 0);
  assert.equal(stop.success, true, stop.error);
  assert.equal(slides.slide(A).stopped, 1);
  slides.release();
  await move;
  await flush();
  await flush();
  assert.equal(slides.slide(A).stopped, 2, 'STOP again once the move was answered');
});

test('STOP works before the first read after a restart (identity kept in /data)', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  await createAll(first.gladys);
  first.app.stop();
  assert.deepEqual(store.data.slides, [{ address: A, id: MAC_A, readAt: first.clock.now() }]);
  const second = await setup(t, {
    store,
    read: false,
    devices: first.gladys.fake.devices,
    slides: first.slides,
  });
  first.slides.clear();
  const ack = await press(second.gladys, MAC_A, 'state', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(first.slides.paths(A), ['/rpc/Slide.Stop']);
});

test('a command that may have left is never "not sent"', async (t) => {
  const { gladys, slides, app } = await setup(t);
  await createAll(gladys);
  // Fails before the connection: not sent. (GetInfo answers, then SetPos fails.)
  slides.fail(A, {}, { before: 'unreachable' });
  let ack = await press(gladys, MAC_A, 'state', 1);
  assert.match(ack.error, /commande non envoyée/);
  // Fails once written: sent, without confirmation, badge degraded.
  slides.fail(A, {}, { after: 'timeout' });
  ack = await press(gladys, MAC_A, 'state', -1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée au Slide, sans confirmation/);
  assert.ok(app.unconfirmed.has(MAC_A));
  await flush();
  const badge = gladys.fake.transports.at(-1);
  assert.equal(badge.degraded, true);
  // A 5xx: sent, without confirmation, and the Slide is paused.
  slides.fail(A, {}, { status: 503 });
  ack = await press(gladys, MAC_A, 'state', 1);
  assert.match(ack.error, /sans confirmation/);
  assert.ok(app.pauseOf(app.slots.get(A)));
});

test('a move is confirmed only by a read of the position asked', async (t) => {
  const { gladys, slides, app, timeouts, clock } = await setup(t);
  await createAll(gladys);
  slides.set(A, { moveAtOnce: false });
  const ack = await press(gladys, MAC_A, 'position', 100);
  assert.equal(ack.success, true);
  assert.equal(app.targets.get(MAC_A), 100);
  await runFollowUps(timeouts, clock);
  assert.equal(app.targets.has(MAC_A), false);
  assert.equal(app.notReached.get(MAC_A), 75, 'still at pos 0.25 after the travel');
  assert.match(gladys.fake.transports.at(-1).message.en, /not reached/);
  // The curtain then moves to the position asked: the badge clears.
  slides.set(A, { pos: 0, moveAtOnce: true });
  timeouts.length = 0;
  await press(gladys, MAC_A, 'position', 100);
  await runFollowUps(timeouts, clock);
  assert.equal(app.notReached.has(MAC_A), false);
  assert.equal(gladys.fake.transports.at(-1).degraded, undefined);
});

test('calibration only when allowed, checked again right before it leaves', async (t) => {
  const { gladys, slides, app } = await setup(t);
  await createAll(gladys);
  let ack = await press(gladys, MAC_A, 'calibrate', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /calibrage est désactivé/);
  assert.equal(slides.slide(A).calibrated, undefined);
  await gladys.fake.configUpdated({ slides: A, allow_calibration: true });
  ack = await press(gladys, MAC_A, 'calibrate', 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(slides.slide(A).calibrated, 1);
  // Turned off while the identity read runs: never sent.
  slides.holdAll();
  const pending = press(gladys, MAC_A, 'calibrate', 1);
  await flush();
  app.config = { ...app.config, allowCalibration: false };
  slides.holdAll(false);
  slides.release();
  ack = await pending;
  assert.equal(ack.success, false);
  assert.equal(slides.slide(A).calibrated, 1);
});

test('API v1: the device code answers the Digest challenge, never logged nor stored', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A, version: 1, code: CODE, pos: 1 } });
  const { gladys, logs, store } = await setup(t, {
    slides,
    config: { slides: A, device_codes: `${A}=${CODE}` },
  });
  assert.equal(status(gladys).connected, true, status(gladys).message.en);
  await createAll(gladys);
  const ack = await press(gladys, MAC_A, 'state', 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(slides.slide(A).pos, 0);
  const everything = JSON.stringify([logs, store.data, gladys.fake.connectionStatuses]);
  assert.ok(!everything.includes(CODE));
});

test('a refused code stops that Slide for good, until another code or the Test button', async (t) => {
  const slides = fakeSlides({
    [A]: { mac: MAC_A, version: 1, code: CODE },
    [B]: { mac: MAC_B },
  });
  const clock = fakeClock();
  const store = memoryStore();
  const { gladys, app } = await setup(t, {
    slides,
    clock,
    store,
    config: { slides: `${A}, ${B}`, device_codes: `${A}=WRONG123` },
  });
  assert.match(status(gladys).message.en, /device code was refused/);
  assert.equal(status(gladys).connected, true, 'the other Slide answers');
  assert.equal(store.data.blocks.length, 1);
  assert.ok(!JSON.stringify(store.data).includes('WRONG123'));
  // Never tried again by itself, however long.
  slides.clear();
  clock.advance(24 * 3600_000);
  await app.tick({ scheduled: true });
  assert.deepEqual(slides.paths(A), []);
  assert.deepEqual(slides.paths(B), ['/rpc/Slide.GetInfo']);
  // The Test button tries once; still refused, still blocked.
  clock.advance(60_000);
  slides.clear();
  await gladys.fake.action('test_connection');
  assert.equal(slides.paths(A).length, 2, 'probe + Digest');
  assert.equal(store.data.blocks[0].failures, 2);
  // Another code lifts it at once (a configuration saved).
  await gladys.fake.configUpdated({ slides: `${A}, ${B}`, device_codes: `${A}=${CODE}` });
  await app.tick({ scheduled: true });
  assert.deepEqual(store.data.blocks, []);
  assert.doesNotMatch(status(gladys).message.en, /refused/);
});

test('API v1 without a code: asked in the status, not retried', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A, version: 1, code: CODE } });
  const { gladys, app, clock } = await setup(t, { slides });
  assert.match(status(gladys).message.en, /asks for its device code/);
  slides.clear();
  clock.advance(3600_000);
  await app.tick({ scheduled: true });
  assert.deepEqual(slides.paths(A), []);
});

test('429: a pause kept in /data, bounded, that a restart and a reconnection keep', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A } });
  slides.fail(A, { status: 429, headers: { 'retry-after': '999999' } });
  const store = memoryStore();
  const clock = fakeClock();
  const { gladys, app } = await setup(t, { slides, store, clock });
  const until = store.data.pauses[0].until;
  assert.equal(until, clock.now() + TIMINGS.pauseMax, 'bounded to 6 h');
  assert.match(status(gladys).message.en, /paused/);
  slides.clear();
  await reconnect(gladys);
  clock.advance(3600_000);
  await app.tick({ scheduled: true });
  assert.deepEqual(slides.paths(A), [], 'nothing asked during the pause');
  app.stop();
  const again = await setup(t, { slides, store, clock, read: false });
  await again.app.tick({ scheduled: true });
  assert.deepEqual(slides.paths(A), []);
});

test('never read sooner than the interval: Test button, reconnection, unchanged save, restart', async (t) => {
  const store = memoryStore();
  const clock = fakeClock();
  const { gladys, app, slides } = await setup(t, { store, clock });
  slides.clear();
  const answer = await gladys.fake.action('test_connection');
  assert.match(answer.data?.message?.en ?? JSON.stringify(answer), /next read is in/);
  await reconnect(gladys);
  await gladys.fake.configUpdated({ slides: A });
  await app.tick();
  assert.deepEqual(slides.paths(A), []);
  // Restart: the last read kept in /data (at most a minute old) holds it back.
  clock.advance(5000);
  app.stop();
  const again = await setup(t, { store, clock, slides, read: false });
  const next = again.timeouts.filter((x) => x.ms > 0).at(-1);
  assert.ok(next.ms >= 30_000 - 5000, `next read in ${next.ms} ms`);
  await again.app.tick();
  assert.deepEqual(slides.paths(A), []);
});

test('a reconnection to Gladys republishes the status and the Discovery, reads nothing', async (t) => {
  const { gladys, slides } = await setup(t);
  await createAll(gladys);
  const statuses = gladys.fake.connectionStatuses.length;
  const discovered = gladys.fake.wsMessages.length;
  slides.clear();
  await reconnect(gladys);
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  assert.ok(gladys.fake.discoveredDevices.length === 1);
  assert.ok(gladys.fake.wsMessages.length >= discovered);
  assert.deepEqual(slides.paths(A), []);
});

test('two Slides swap their addresses: each keeps its device', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A }, [B]: { mac: MAC_B, name: 'Chambre' } });
  const { gladys, app, clock } = await setup(t, { slides, config: { slides: `${A},${B}` } });
  await createAll(gladys);
  slides.set(A, { mac: MAC_B, name: 'Chambre' });
  slides.set(B, { mac: MAC_A, name: 'Salon' });
  clock.advance(30_000);
  await app.tick({ scheduled: true });
  assert.equal(app.slotOf(MAC_A).key, B);
  assert.equal(app.slotOf(MAC_B).key, A);
  slides.clear();
  const ack = await press(gladys, MAC_A, 'state', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(slides.paths(B), ['/rpc/Slide.GetInfo', '/rpc/Slide.SetPos']);
});

test('a Slide gone from the addresses is unreachable and named, never deleted', async (t) => {
  const { gladys, app, slides, clock } = await setup(t);
  await createAll(gladys);
  slides.set(A, { mac: MAC_B });
  clock.advance(30_000);
  await app.tick({ scheduled: true });
  assert.match(status(gladys).message.en, /Not found at the addresses typed: Salon/);
  const badge = gladys.fake.transports.filter((x) => x.device_external_id === id(MAC_A)).at(-1);
  assert.equal(badge.transport, 'unreachable');
  assert.ok(gladys.fake.discoveredDevices.some((d) => d.external_id === id(MAC_A)));
});

test('a created device never loses a feature it has', async (t) => {
  const extra = {
    name: 'Old',
    external_id: id(MAC_A, 'old'),
    category: 'curtain',
    type: 'state',
    read_only: true,
    has_feedback: false,
    keep_history: false,
    min: 0,
    max: 1,
  };
  const devices = [
    {
      name: 'Salon',
      external_id: id(MAC_A),
      selector: 'salon',
      features: [extra],
    },
  ];
  const { gladys } = await setup(t, { devices });
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === id(MAC_A));
  assert.ok(device.features.some((f) => f.external_id === id(MAC_A, 'old')));
});

test('unreachable: retried later with a growing delay, never sooner than the interval', async (t) => {
  const slides = fakeSlides({});
  const { gladys, app, clock } = await setup(t, { slides });
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /unreachable/);
  slides.add(A, { mac: MAC_A });
  slides.clear();
  clock.advance(30_000);
  await app.tick({ scheduled: true });
  assert.equal(slides.paths(A).length, 1, 'after 30 s');
  assert.equal(status(gladys).connected, true);
});

test('the configuration: invalid addresses and too many Slides are said', async (t) => {
  const { gladys } = await setup(t, {
    config: { slides: `${A}, http://, salon.local, user:pw@1.2.3.4` },
  });
  const message = status(gladys).message.en;
  assert.match(message, /not understood/);
  assert.match(message, /\.local/);
  assert.match(message, /user name nor a password/);
  assert.doesNotMatch(message, /pw@/);
});

test('no Slide typed: the status asks for one', async (t) => {
  const { gladys } = await setup(t, { config: {} });
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /Saisissez l'adresse IP de chaque Slide/);
});
