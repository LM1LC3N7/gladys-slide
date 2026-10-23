// -----------------------------------------------------------------------------
// The minor points left by the approval of review 1 (m1-m3). Same harness as
// test/review1.test.js: the SDK's fake Gladys, fake Slides behind the client's
// `request`, a fake clock, recorded timers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SlideApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { SlideClient } from '../src/slide/client.js';
import { memoryStore } from '../src/store.js';
import { MAC_A, MAC_B, fakeClock, fakeSlides } from './helpers/fakeSlide.js';

const SELECTOR = 'slide';
const A = '192.168.1.40';
const B = '192.168.1.41';
const id = (mac) => `ext:${SELECTOR}:slide:${mac}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function setup(t, { config = { slides: A }, slides }) {
  const clock = fakeClock();
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: [] });
  const timers = {
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const app = new SlideApp({
    gladys,
    logger: quiet,
    client: new SlideClient({ request: slides.request, now: clock.now }),
    store: memoryStore(),
    now: clock.now,
    timers,
  });
  registerHandlers(gladys, app, quiet);
  await gladys.connect();
  await app.tick({ scheduled: true });
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
  t.after(() => app.stop());
  return { gladys, app };
}

function press(gladys, mac, key, value) {
  const device = gladys.fake.devices.find((d) => d.external_id === id(mac));
  return gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id.endsWith(`:${key}`)),
    value,
  );
}

/** A move whose SetPos is written and held, as when a STOP arrives during it. */
async function moveInFlight(gladys, slides, value = 1) {
  slides.holdAll();
  const move = press(gladys, MAC_A, 'state', value);
  await flush();
  slides.release(); // the identity read answers; the SetPos leaves and is held
  await flush();
  await flush();
  assert.equal(slides.requests.at(-1).path, '/rpc/Slide.SetPos');
  slides.holdAll(false);
  // Wrapped: an async function returning the promise would wait for it.
  return { move };
}

test('m1: the second STOP is not sent when a move was asked after the STOP', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A, pos: 0.5 } });
  const { gladys } = await setup(t, { slides });
  const { move: first } = await moveInFlight(gladys, slides, 1);
  const stop = await press(gladys, MAC_A, 'state', 0);
  assert.equal(stop.success, true, stop.error);
  assert.equal(slides.slide(A).stopped, 1);
  // Asked after the STOP: it waits behind the move in flight.
  const second = press(gladys, MAC_A, 'state', -1);
  await flush();
  slides.release();
  await first;
  const ack = await second;
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(ack.success, true, ack.error);
  assert.equal(slides.slide(A).stopped, 1, 'no second STOP over the newer move');
  assert.equal(slides.slide(A).asked, 1, 'the newer move (close) is the last one');
});

test('m1: without a newer move, the second STOP still follows the move in flight', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A, pos: 0.5 } });
  const { gladys } = await setup(t, { slides });
  const { move } = await moveInFlight(gladys, slides, 1);
  await press(gladys, MAC_A, 'state', 0);
  slides.release();
  await move;
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(slides.slide(A).stopped, 2);
});

test('m2: a move answered after a STOP leaves no position to wait for', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A, pos: 0.5 } });
  const { gladys, app } = await setup(t, { slides });
  const { move } = await moveInFlight(gladys, slides, 1);
  await press(gladys, MAC_A, 'state', 0);
  slides.release();
  await move;
  assert.equal(app.targets.has(MAC_A), false, 'no "position not reached" badge later');
});

test('m3: a configuration changed meanwhile is said so, not "at no address"', async (t) => {
  const slides = fakeSlides({ [A]: { mac: MAC_A }, [B]: { mac: MAC_B } });
  const { gladys, app } = await setup(t, { slides, config: { slides: `${A}, ${B}` } });
  slides.holdAll();
  const move = press(gladys, MAC_A, 'state', 1);
  await flush();
  // Another Slide's code changes: A keeps its slot, the generation changes.
  await app.configUpdated({ slides: `${A}, ${B}`, device_codes: `${B}=ABCD1234` });
  slides.holdAll(false);
  slides.release();
  const ack = await move;
  assert.equal(ack.success, false);
  assert.match(ack.error, /configuration a changé entre-temps/);
  assert.ok(!slides.paths(A).includes('/rpc/Slide.SetPos'));
});
