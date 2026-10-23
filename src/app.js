// -----------------------------------------------------------------------------
// The integration: the Slides typed in the configuration (their IP addresses,
// and the device code of those on API v1), one GetInfo of each every poll
// interval, one Gladys device per Slide (a curtain), the transport badges, the
// "Test the connection" button, and the commands (open, close, stop,
// position, calibration). index.js only wires the SDK handlers to it.
//
// Commands:
//   - a move (open, close, position) or a calibration goes through the lane of
//     its Slide (one request at a time, before the reads): first a GetInfo
//     that checks the identity (MAC) of the Slide at that address (a DHCP
//     lease may give it to another one; an identity that cannot be read is
//     not "another Slide", but no move leaves without it), then the request;
//     sent within 3.5 s of the click or refused unsent, answered by 4.3 s;
//   - STOP never waits: no lane, no identity read, through a 429/5xx pause or
//     a refused code (one try), works before the first read (the identity of
//     each address is kept in /data), and cancels at once every move of that
//     Slide not sent yet; a move that was leaving meanwhile is followed by a
//     second STOP;
//   - calibration only when "Allow calibration" is on, checked on arrival,
//     after the identity read and right before the request leaves;
//   - a request that may have reached the Slide is never answered "not
//     sent": "sent, without confirmation", then reads; never retried. A
//     position is confirmed only by a read equal to it (within 2 %);
//   - the ack never waits for a publication to Gladys.
// Reads: never sooner than the interval (the Test button, a scan, a
// reconnection to Gladys, a configuration saved unchanged, a restart: the time
// of the last read is kept in /data), except the reads that follow a command;
// one read at a time per Slide; a read begun before a command left is not
// applied; a read of an older configuration publishes nothing (generation
// checked after every await).
// Failures, per Slide: a code refused (or missing on API v1) -> a final stop
// kept in /data (another code, or a success of the Test button, lifts it);
// 429/5xx -> a pause of 1 min to 6 h kept in /data; anything else -> 30 s,
// 1, 2, 5 min, never sooner than the interval. A reconnection to Gladys
// clears none of them.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey, normalizeConfig } from './config.js';
import { COVER_STATE, FEATURES, LIMITS, PRESSED, SECOND, TIMINGS } from './constants.js';
import {
  buildDevice,
  infoOf,
  nameOf,
  numberIn,
  parseExternalId,
  slideIds,
  slidePosFor,
} from './devices.js';
import { ERRORS, T, age, join, reasonOf, word } from './i18n.js';
import { Lane, PRIORITY } from './lane.js';
import { StatePublisher } from './publisher.js';
import { fileStore, fingerprintOf, normalizeMemory } from './store.js';
import { SlideClient } from './slide/client.js';

/** The fields kept from a feature created in Gladys, when it is published again as it is. */
const KEPT_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'unit',
  'read_only',
  'has_feedback',
  'keep_history',
];

const COMMAND_KEYS = new Set([FEATURES.STATE, FEATURES.POSITION, FEATURES.CALIBRATE]);
const AUTH_KINDS = new Set(['auth', 'codeNeeded']);
const PAUSE_KINDS = new Set(['rate', 'server']);
const NOT_SLIDE_KINDS = new Set(['format', 'http', 'invalid', 'tooLarge']);

const freshSlot = ({ key, address, code }) => ({
  key,
  address,
  code,
  lane: new Lane(),
  /** The identity of the Slide at the address: read, or kept in /data (undefined: unknown). */
  id: undefined,
  /** The last info read (a plain record), or undefined. */
  info: undefined,
  /** undefined: not read yet since the start; true: answered; false: failing. */
  online: undefined,
  failures: 0,
  nextRetryAt: -Infinity,
  wait: undefined,
  error: undefined,
  reason: undefined,
  reading: undefined,
  readingSince: -Infinity,
  /** When this Slide was last asked by a cycle (never sooner than the interval after). */
  attemptAt: -Infinity,
  /** When its last read was applied (its position is published while recent). */
  readAt: undefined,
  /** After a restart: when it was last read, kept in /data (the status until the first read). */
  restoredAt: undefined,
});

export class SlideApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'slide' }),
    client = new SlideClient(),
    store = fileStore(),
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.client = client;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.connKey = undefined;
    this.memory = undefined;
    this.generation = 0;
    this.started = false;
    /** address key -> slot */
    this.slots = new Map();
    /** When the Slides were last read by this process (exact). */
    this.lastAttemptAt = -Infinity;
    this.timer = undefined;
    this.running = undefined;
    /** Slide id -> follow-up timers */
    this.followUps = new Map();
    /** Slide id -> position read (Gladys percent) */
    this.positions = new Map();
    /** Slide id -> the position asked by the last move accepted */
    this.targets = new Map();
    /** Slide id -> the position read when the last move did not reach its target */
    this.notReached = new Map();
    /** Slide ids whose command was sent without confirmation */
    this.unconfirmed = new Set();
    /** Slide id -> tickets of the moves not sent yet (a STOP cancels them) */
    this.tickets = new Map();
    /** Slide id -> the move between its first byte and its answer */
    this.inFlight = new Map();
    /** Commands numbered on arrival; Slide id -> number of its last move asked */
    this.commandSeq = 0;
    /** Slide id -> number of the last move whose acting request LEFT (review 3) */
    this.sentMoveSeq = new Map();
    /** Slide id -> when its last command left: a read begun before is not applied */
    this.lastSentAt = new Map();
    /** device external id -> device published in this run (a publication never shrinks) */
    this.known = new Map();
    this.lastStatus = undefined;
    this.published = undefined;
    this.badges = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    if (!this.memory) {
      this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
      // Written at most once a minute: the real last read may be up to a
      // minute later than the one kept.
      if (this.memory.lastAttemptAt > 0) {
        this.lastAttemptAt = Math.min(
          this.now(),
          this.memory.lastAttemptAt + TIMINGS.attemptPersistEvery,
        );
      }
    }
    if (generation !== this.generation) {
      return;
    }
    const restart = this.connKey === undefined;
    this.config = normalizeConfig(raw);
    this.connKey = connectionKey(this.config);
    // A Slide whose address and code did not change keeps its slot (its last
    // read, its failures): only the new or changed ones are read at once
    // (review M5). After a restart, every slot starts from the last read kept
    // in /data.
    const previous = this.slots;
    this.slots = new Map(
      this.config.slides.map((s) => {
        const kept = previous.get(s.key);
        if (kept && kept.code === s.code) {
          return [s.key, kept];
        }
        const slot = freshSlot(s);
        if (restart) {
          slot.attemptAt = this.lastAttemptAt;
        }
        return [s.key, slot];
      }),
    );
    // The Slide last read at each address, attached before any await: "Stop"
    // works before the first read, and during this start (review M1).
    for (const kept of this.memory.slides) {
      const slot = this.slots.get(kept.address);
      if (slot && !slot.id) {
        slot.id = kept.id;
        slot.restoredAt = kept.readAt > 0 ? kept.readAt : undefined;
      }
    }
    await this.tidyMemory();
    if (generation !== this.generation) {
      return;
    }
    this.published = undefined;
    this.badges = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    await this.publishAll();
    if (generation !== this.generation || this.slots.size === 0) {
      return;
    }
    // New addresses or codes are due at once (a pause or a block still
    // holds); the others never sooner than the interval.
    this.schedule();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handles of this.followUps.values()) {
      for (const handle of handles) {
        this.timers.clearTimeout(handle);
      }
    }
    this.followUps.clear();
    this.publisher.stop();
    if (this.memory && this.lastAttemptAt > this.memory.lastAttemptAt) {
      this.memory.lastAttemptAt = this.lastAttemptAt;
      return this.saveMemory();
    }
    return Promise.resolve();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery tab, badges) and the
   * last states, without reading the Slides again. Pauses and blocks stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw, { republish: true });
  }

  /**
   * A configuration saved. New addresses or codes start over; anything else
   * (interval, calibration, language) applies at once, without a read.
   */
  async configUpdated(raw = {}, { republish = false } = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    const next = normalizeConfig(raw);
    if (connectionKey(next) !== this.connKey) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    // The slots keep their state; only the options change.
    this.config = next;
    if (previous.allowCalibration !== next.allowCalibration) {
      this.logger.info(`Calibration ${next.allowCalibration ? 'allowed' : 'disabled'}`);
    }
    if (previous.pollInterval !== next.pollInterval && this.timer && !this.running) {
      this.schedule();
    }
    if (republish) {
      this.published = undefined;
      this.badges = undefined;
      this.lastStatus = undefined;
    } else if (previous.language !== next.language) {
      this.published = undefined;
    }
    await this.publishAll({ states: republish });
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /**
   * Pauses, blocks and identities of addresses no longer configured are
   * dropped; a block lifts when another code was typed for its address.
   */
  async tidyMemory() {
    const m = this.memory;
    const before = JSON.stringify([m.pauses, m.blocks, m.slides]);
    m.pauses = m.pauses.filter((p) => this.slots.has(p.address));
    m.slides = m.slides.filter((s) => this.slots.has(s.address));
    m.blocks = m.blocks.filter((b) => {
      const slot = this.slots.get(b.address);
      return slot && b.fp === fingerprintOf(m.salt, slot.key, slot.code);
    });
    if (JSON.stringify([m.pauses, m.blocks, m.slides]) !== before) {
      await this.saveMemory();
    }
  }

  // --- Pauses and blocks -----------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** How long a read stays recent: two intervals and a minute. */
  freshFor() {
    return 2 * this.interval + TIMINGS.attemptPersistEvery;
  }

  pauseOf(slot) {
    const pause = this.memory?.pauses.find((p) => p.address === slot.key);
    return pause && this.now() < pause.until ? pause : undefined;
  }

  blockOf(slot) {
    return this.memory?.blocks.find((b) => b.address === slot.key);
  }

  /** 429 or 5xx: every read and every move of that Slide waits, kept in /data. */
  async pause(slot, err) {
    const previous = this.memory.pauses.find((p) => p.address === slot.key);
    const failures = (previous?.failures ?? 0) + 1;
    const asked = err.retryAfter ?? TIMINGS.pauseMin * 2 ** Math.min(failures - 1, 10);
    const wait = Math.min(
      TIMINGS.pauseMax,
      Math.max(TIMINGS.pauseMin, this.interval, Math.min(asked, TIMINGS.pauseMax)),
    );
    this.memory.pauses = [
      ...this.memory.pauses.filter((p) => p.address !== slot.key),
      { address: slot.key, until: this.now() + wait, failures },
    ];
    await this.saveMemory();
    this.logger.warn(`Slide ${slot.key}: ${reasonOf(err).en}, paused for ${age(wait)}`);
  }

  /**
   * The device code refused (or missing): a final stop for that address,
   * with the salted fingerprint of the refused code, never retried by itself.
   */
  async block(slot, kind) {
    const previous = this.blockOf(slot);
    this.memory.blocks = [
      ...this.memory.blocks.filter((b) => b.address !== slot.key),
      {
        address: slot.key,
        fp: fingerprintOf(this.memory.salt, slot.key, slot.code),
        kind,
        failures: (previous?.failures ?? 0) + 1,
      },
    ];
    await this.saveMemory();
    this.logger.warn(
      `Slide ${slot.key}: ${kind === 'auth' ? 'device code refused' : 'device code needed'}; not tried again until the code changes or the Test button`,
    );
  }

  /** A success: the pause and the block of that address are lifted. */
  async clearHolds(slot) {
    const pauses = this.memory.pauses.filter((p) => p.address !== slot.key);
    const blocks = this.memory.blocks.filter((b) => b.address !== slot.key);
    if (
      pauses.length !== this.memory.pauses.length ||
      blocks.length !== this.memory.blocks.length
    ) {
      this.memory.pauses = pauses;
      this.memory.blocks = blocks;
      await this.saveMemory();
    }
  }

  // --- Polling ---------------------------------------------------------------

  /** The connection of a Slide (the code is only handed to the client). */
  target(slot) {
    return { address: slot.address, code: slot.code };
  }

  /** The slot where the Slide `id` was last read, if any. */
  slotOf(id) {
    for (const slot of this.slots.values()) {
      if (slot.id === id) {
        return slot;
      }
    }
    return undefined;
  }

  /**
   * When the next cycle has something to read: the earliest of the Slides
   * (the interval after its last read, the end of its pause, its next try);
   * a blocked Slide waits for nothing; all blocked: an interval from now
   * (review B1: never a cycle that reads nothing at 0 ms, again and again).
   */
  nextCycleAt() {
    let next = Infinity;
    for (const slot of this.slots.values()) {
      if (this.blockOf(slot)) {
        continue;
      }
      const pause = this.pauseOf(slot);
      let at = slot.attemptAt + this.interval;
      if (pause) {
        at = pause.until;
      } else if (slot.online === false) {
        at = Math.max(at, slot.nextRetryAt);
      }
      next = Math.min(next, at);
    }
    return next === Infinity ? this.now() + this.interval : next;
  }

  /** The next cycle of reads. */
  schedule(delay) {
    this.clearTimer();
    const wait = delay ?? this.nextCycleAt() - this.now();
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick({ scheduled: true }).catch(() => this.logger.error('Refresh failed'));
        }
      },
      Math.max(0, wait),
    );
  }

  /**
   * One cycle at a time: a tick during a cycle joins it (a reconnection never
   * starts a second one). `scheduled`: the timer, a start after new
   * addresses or codes, the Test button once the interval has passed.
   * `trial`: the Test button, which tries a blocked Slide once.
   */
  tick(options = {}) {
    if (!this.running) {
      this.running = this.run(options).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Whether a cycle reads this slot now. */
  due(slot, trial) {
    if (this.pauseOf(slot)) {
      return false;
    }
    if (this.blockOf(slot) && !trial) {
      return false;
    }
    if (trial) {
      return true;
    }
    const at = slot.attemptAt + this.interval;
    return this.now() >= (slot.online === false ? Math.max(at, slot.nextRetryAt) : at);
  }

  async run({ scheduled = false, trial = false } = {}) {
    const generation = this.generation;
    const now = this.now();
    if (this.slots.size === 0) {
      return;
    }
    if (!scheduled && now < this.lastAttemptAt + this.interval) {
      await this.updateStatus();
      if (generation === this.generation && !this.timer) {
        this.schedule();
      }
      return;
    }
    // Whatever happens below, the next cycle is scheduled: the chain of reads
    // never dies on an error (a value not understood, a publication failing).
    let read = false;
    try {
      const due = [...this.slots.values()].filter((slot) => this.due(slot, trial));
      if (due.length > 0) {
        read = true;
        // Written BEFORE the reads: a restart in the middle never reads sooner.
        for (const slot of due) {
          slot.attemptAt = now;
        }
        await this.noteAttempt(now);
        if (generation !== this.generation) {
          return;
        }
        // Different Slides answer independently: read them side by side.
        await Promise.all(due.map((slot) => this.readSlot(slot, generation)));
      }
      if (generation !== this.generation) {
        return;
      }
      await this.publishAll();
    } catch (err) {
      this.logger.error(`Refresh failed: ${err?.message ?? 'error'}`);
    } finally {
      if (generation === this.generation) {
        // A cycle that read nothing never comes back at once.
        const wait = this.nextCycleAt() - this.now();
        this.schedule(read ? wait : Math.max(wait, SECOND));
      }
    }
  }

  /** The time of a cycle: exact in memory, in /data at most once a minute. */
  async noteAttempt(now) {
    this.lastAttemptAt = now;
    if (now - this.memory.lastAttemptAt >= TIMINGS.attemptPersistEvery) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  /**
   * One read of a Slide at a time: a read asked while one runs joins it,
   * unless that one began before a command of this Slide left (it would show
   * the curtain before it): then it runs after it.
   */
  readSlot(slot, generation) {
    const sent = slot.id === undefined ? -Infinity : (this.lastSentAt.get(slot.id) ?? -Infinity);
    if (slot.reading && slot.readingSince > sent) {
      return slot.reading;
    }
    const previous = slot.reading ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.readNow(slot, generation));
    slot.reading = run;
    slot.readingSince = this.now();
    run
      .finally(() => {
        if (slot.reading === run) {
          slot.reading = undefined;
        }
      })
      .catch(() => {});
    return run;
  }

  async readNow(slot, generation) {
    if (generation !== this.generation) {
      return;
    }
    let startedAt;
    let json;
    try {
      json = await slot.lane.run(PRIORITY.read, () => {
        startedAt = this.now();
        return this.client.info(this.target(slot), { timeout: TIMINGS.readTimeout });
      });
    } catch (err) {
      if (generation === this.generation) {
        await this.readFailed(slot, err);
      }
      return;
    }
    if (generation === this.generation) {
      await this.applyRead(slot, json, startedAt);
    }
  }

  /**
   * A GetInfo answered: the identity first (a DHCP lease may give the address
   * to another Slide; an identity that cannot be read is not "another
   * Slide"), then the position, unless the read began before a command left.
   */
  async applyRead(slot, json, startedAt) {
    const generation = this.generation;
    if (this.slots.get(slot.key) !== slot) {
      // A slot of a replaced configuration (a command answered late): nothing.
      return;
    }
    const info = infoOf(json);
    slot.online = true;
    slot.failures = 0;
    slot.wait = undefined;
    slot.error = undefined;
    slot.reason = undefined;
    await this.clearHolds(slot);
    if (generation !== this.generation) {
      return;
    }
    if (!info.id) {
      slot.error = 'noId';
      return;
    }
    if (slot.id && slot.id !== info.id) {
      this.logger.warn(`Another Slide answers at ${slot.key} now`);
    }
    // One Slide is at one address: another slot that named it is out of date.
    for (const other of this.slots.values()) {
      if (other !== slot && other.id === info.id) {
        other.id = undefined;
        other.info = undefined;
      }
    }
    slot.id = info.id;
    slot.info = info;
    // The identity at the address, and when it was last read (the status
    // after a restart, review M2): written at most once a minute.
    const kept = this.memory.slides.find((s) => s.address === slot.key);
    const now = this.now();
    if (kept?.id !== info.id || now - (kept.readAt ?? 0) >= TIMINGS.attemptPersistEvery) {
      this.memory.slides = [
        ...this.memory.slides.filter((s) => s.address !== slot.key && s.id !== info.id),
        { address: slot.key, id: info.id, readAt: now },
      ];
      await this.saveMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    if (startedAt <= (this.lastSentAt.get(info.id) ?? -Infinity)) {
      this.logger.debug('Read begun before a command, position not applied');
      return;
    }
    if (info.position === undefined) {
      return;
    }
    const id = info.id;
    this.positions.set(id, info.position);
    slot.readAt = this.now();
    const target = this.targets.get(id);
    if (target === undefined) {
      // No move waits for a confirmation: a STOP or a calibration is
      // confirmed by any read; "not reached" stays until the curtain moves.
      this.unconfirmed.delete(id);
      if (this.notReached.has(id) && this.notReached.get(id) !== info.position) {
        this.notReached.delete(id);
      }
    } else if (Math.abs(target - info.position) <= LIMITS.positionTolerance) {
      // A move is confirmed only by a position read equal to the one asked.
      this.targets.delete(id);
      this.unconfirmed.delete(id);
      this.notReached.delete(id);
    }
  }

  /** A failed read. */
  async readFailed(slot, err) {
    if (this.slots.get(slot.key) !== slot) {
      return;
    }
    slot.online = false;
    slot.error = err?.kind ?? 'error';
    slot.reason = reasonOf(err);
    if (AUTH_KINDS.has(err?.kind)) {
      await this.block(slot, err.kind);
      return;
    }
    if (PAUSE_KINDS.has(err?.kind)) {
      await this.pause(slot, err);
      return;
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(slot.failures, TIMINGS.backoff.length - 1)],
    );
    slot.failures += 1;
    slot.wait = wait;
    slot.nextRetryAt = this.now() + wait;
    this.logger.warn(`Slide ${slot.key}: ${reasonOf(err).en}; next try in ${age(wait)}`);
  }

  // --- Status ----------------------------------------------------------------

  /** The state of a slot, for its line of the status. */
  slotState(slot) {
    const block = this.blockOf(slot);
    if (block) {
      return { kind: block.kind === 'auth' ? 'blocked' : 'codeNeeded' };
    }
    const pause = this.pauseOf(slot);
    if (pause) {
      return {
        kind: 'paused',
        wait: age(pause.until - this.now()),
        reason: slot.reason ?? reasonOf({ kind: 'rate' }),
      };
    }
    if (slot.online === undefined) {
      // After a restart: answered recently (kept in /data), so still taken as
      // connected until the first read (review M2).
      if (slot.restoredAt !== undefined && this.now() - slot.restoredAt < this.freshFor()) {
        return { kind: 'ok', position: undefined };
      }
      return { kind: 'connecting' };
    }
    if (slot.online) {
      if (slot.error === 'noId') {
        return { kind: 'noId', wait: age(this.interval) };
      }
      return { kind: 'ok', position: slot.id ? this.positions.get(slot.id) : undefined };
    }
    const wait = age(slot.wait ?? this.interval);
    return {
      kind: NOT_SLIDE_KINDS.has(slot.error) ? 'notSlide' : 'unreachable',
      wait,
      reason: slot.reason ?? reasonOf(undefined),
    };
  }

  /** `[connected, message]`. */
  status() {
    const config = this.config;
    const notes = [
      config.credentialsInHost ? T.credentialsInHost : undefined,
      config.invalid.length > 0 ? T.invalid(config.invalid.join(', ')) : undefined,
      config.local ? T.local : undefined,
      config.dropped > 0 ? T.dropped(config.dropped) : undefined,
      config.badCodes ? T.badCodes : undefined,
    ];
    if (this.slots.size === 0) {
      return [false, join(T.noSlides, ...notes)];
    }
    const lines = [];
    let online = 0;
    for (const slot of this.slots.values()) {
      const state = this.slotState(slot);
      if (state.kind === 'ok') {
        online += 1;
      }
      const name = slot.info ? `${nameOf(slot.info)} (${slot.key})` : slot.key;
      lines.push(T.slideLine(name, state));
    }
    const orphans = this.orphans();
    const names = orphans
      .map((d) =>
        typeof d.name === 'string' && d.name !== ''
          ? d.name.slice(0, LIMITS.name)
          : d.external_id.split(':').at(-1),
      )
      .join(', ');
    return [
      online > 0,
      join(
        T.summary(online, this.slots.size, config.pollInterval),
        ...lines,
        orphans.length > 0 ? T.orphans(names) : undefined,
        T.calibration(config.allowCalibration),
        ...notes,
      ),
    ];
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    let connected;
    let message;
    try {
      [connected, message] = this.status();
    } catch (err) {
      // Never a dead status: a value not understood is said so.
      this.logger.error(`Status failed: ${err?.message ?? 'error'}`);
      [connected, message] = [false, ERRORS.generic];
    }
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Gladys ----------------------------------------------------------------

  /**
   * The created devices of this integration that are at none of the addresses:
   * only once every address was tried since the start (a Slide down is not
   * "gone").
   */
  orphans() {
    const slots = [...this.slots.values()];
    if (slots.some((s) => s.online === undefined && !this.blockOf(s) && !this.pauseOf(s))) {
      return [];
    }
    return (this.gladys.devices ?? []).filter((device) => {
      const target = parseExternalId(this.gladys, device?.external_id);
      return target && target.key === undefined && !this.slotOf(target.id);
    });
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async publishAll({ states = true } = {}) {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    if (states) {
      this.queueStates();
      await this.flush();
    }
    await this.publishBadges();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /**
   * The Discovery tab: one device per Slide read in this run. A created
   * device never loses a feature (Gladys would otherwise mark it changed, and
   * "Update" would drop their history), and a device seen earlier in this run
   * stays.
   */
  async publishDevices() {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    for (const slot of this.slots.values()) {
      if (!slot.info?.id || slot.info.id !== slot.id) {
        continue;
      }
      const device = buildDevice(this.gladys, slot.info, { language: this.config.language });
      const published = new Set(device.features.map((f) => f.external_id));
      for (const feature of created.get(device.external_id)?.features ?? []) {
        if (!published.has(feature.external_id)) {
          const kept = {};
          for (const field of KEPT_FIELDS) {
            if (feature[field] !== undefined && feature[field] !== null) {
              kept[field] = feature[field];
            }
          }
          device.features.push(kept);
        }
      }
      this.known.set(device.external_id, device);
    }
    const devices = [...this.known.values()];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** The last positions, for the created features only (the ack never waits for it). */
  queueStates(created = this.createdFeatures()) {
    for (const [id, position] of this.positions) {
      // Only a position read recently from a Slide that answers: never an old
      // one dated anew by the heartbeat (review I4); the badge says the rest.
      const slot = this.slotOf(id);
      if (
        !slot ||
        slot.online !== true ||
        this.blockOf(slot) ||
        this.pauseOf(slot) ||
        slot.readAt === undefined ||
        this.now() - slot.readAt > this.freshFor()
      ) {
        continue;
      }
      const featureId = slideIds(this.gladys, id).feature(FEATURES.POSITION);
      if (created.has(featureId)) {
        this.publisher.push(featureId, { state: position });
      }
    }
  }

  /** The badge of a created Slide. */
  badgeOf(id) {
    const slot = this.slotOf(id);
    if (!slot || slot.online !== true || this.blockOf(slot) || this.pauseOf(slot)) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (this.unconfirmed.has(id)) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.unconfirmed };
    }
    if (this.notReached.has(id)) {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: T.badge.notReached(this.notReached.get(id)),
      };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishBadges() {
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const target = parseExternalId(this.gladys, device?.external_id);
      if (!target || target.key !== undefined) {
        continue;
      }
      // Not tried yet since the start: no badge rather than a wrong one.
      const slot = this.slotOf(target.id);
      if (slot && slot.online === undefined && !this.blockOf(slot) && !this.pauseOf(slot)) {
        continue;
      }
      if (!slot && this.orphans().length === 0) {
        continue;
      }
      entries.push({ external_id: device.external_id, ...this.badgeOf(target.id) });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badges) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badges = json;
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values and its badge at once. */
  async deviceCreated(device) {
    this.badges = undefined;
    const created = this.createdFeatures();
    for (const feature of device?.features ?? []) {
      created.add(feature.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badges = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
    await this.updateStatus();
  }

  /** The Discovery tab asks for a scan: the Slides of the last reads, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  /**
   * "Test the connection": a cycle now, unless one ran less than an interval
   * ago (then its result). A Slide whose code was refused is tried once (the
   * user asks; a success lifts the block); a pause asked by a Slide holds.
   */
  async testConnection() {
    if (this.slots.size === 0) {
      return this.status()[1];
    }
    const now = this.now();
    if (now < this.lastAttemptAt + this.interval) {
      await this.updateStatus();
      return join(T.test.recent(age(this.lastAttemptAt + this.interval - now)), this.status()[1]);
    }
    await this.tick({ scheduled: true, trial: true });
    return this.status()[1];
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.config.language));
    error.refusal = true;
    return error;
  }

  /** What a command asks: { kind: 'stop' } | { kind: 'move', pos, position } | { kind: 'calibrate' }. */
  planOf(key, value) {
    if (key === FEATURES.STATE) {
      const v = numberIn(value, -1, 1);
      if (v === COVER_STATE.STOP) {
        return { kind: 'stop' };
      }
      if (v === COVER_STATE.OPEN) {
        return { kind: 'move', pos: 0, position: 100 };
      }
      if (v === COVER_STATE.CLOSE) {
        return { kind: 'move', pos: 1, position: 0 };
      }
      throw this.refusal(ERRORS.badValue);
    }
    if (key === FEATURES.POSITION) {
      const v = numberIn(value, 0, 100);
      if (v === undefined) {
        throw this.refusal(ERRORS.badValue);
      }
      return { kind: 'move', pos: slidePosFor(v), position: Math.round(v) };
    }
    if (numberIn(value, PRESSED, PRESSED) !== PRESSED) {
      throw this.refusal(ERRORS.badValue);
    }
    return { kind: 'calibrate' };
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseExternalId(this.gladys, feature?.external_id);
    if (!target || !COMMAND_KEYS.has(target.key)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const plan = this.planOf(target.key, value);
    if (plan.kind === 'stop') {
      return this.stopNow(target.id, received);
    }
    if (plan.kind === 'calibrate' && !this.config.allowCalibration) {
      throw this.refusal(ERRORS.calibrationDisabled);
    }
    const slot = this.slotOf(target.id);
    if (!this.memory || !slot) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    // Numbered on arrival; counted as "newer than a STOP" only once its acting
    // request leaves (see send(): a second STOP never stops a move asked and
    // sent after the STOP it repeats, and is never lost to one that did not
    // leave).
    this.commandSeq += 1;
    const ticket = {
      id: target.id,
      seq: this.commandSeq,
      plan,
      generation: this.generation,
      cancelled: false,
    };
    if (!this.tickets.has(target.id)) {
      this.tickets.set(target.id, new Set());
    }
    this.tickets.get(target.id).add(ticket);
    const run = slot.lane.run(PRIORITY.command, () => this.command(slot, ticket, received));
    const finish = () => {
      ticket.finished = true;
    };
    ticket.done = run.then(finish, finish);
    try {
      return await run;
    } finally {
      this.tickets.get(target.id)?.delete(ticket);
    }
  }

  /** The checks of a move, on the latest configuration: on arrival, after the read, before sending. */
  checkCommand(slot, ticket, sendBy) {
    if (ticket.cancelled) {
      throw this.refusal(ERRORS.stopped);
    }
    if (this.stale(slot, ticket.generation)) {
      // New addresses or codes since: nothing for the old ones.
      throw this.refusal(this.staleRefusal(slot));
    }
    if (ticket.plan.kind === 'calibrate' && !this.config.allowCalibration) {
      throw this.refusal(ERRORS.calibrationDisabled);
    }
    if (this.blockOf(slot)) {
      throw this.refusal(ERRORS.blocked);
    }
    const pause = this.pauseOf(slot);
    if (pause) {
      throw this.refusal(ERRORS.paused(age(pause.until - this.now())));
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
  }

  /** A move or a calibration: the identity read, then the request. */
  async command(slot, ticket, received) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const check = () => this.checkCommand(slot, ticket, sendBy);
    check();
    const left = () => sendBy - TIMINGS.commandSendMargin - this.now();
    if (left() <= 0) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // The identity at the address just before acting, never the one in memory.
    const readStart = this.now();
    let json;
    try {
      json = await this.client.info(this.target(slot), {
        timeout: Math.min(left(), TIMINGS.readTimeout),
      });
    } catch (err) {
      if (this.stale(slot, ticket.generation)) {
        throw this.refusal(this.staleRefusal(slot));
      }
      if (AUTH_KINDS.has(err?.kind)) {
        await this.block(slot, err.kind);
      } else if (PAUSE_KINDS.has(err?.kind)) {
        await this.pause(slot, err);
      }
      this.updateStatus().catch(() => {});
      if (err?.kind === 'timeout' && left() <= 0) {
        throw this.refusal(ERRORS.tooSlow);
      }
      // A GetInfo has no effect: nothing was sent.
      throw this.refusal(ERRORS.identityUnknown(reasonOf(err)));
    }
    check();
    const info = infoOf(json);
    // Shown in the background: the ack never waits for Gladys.
    this.applyRead(slot, json, readStart)
      .then(() => this.publishAll())
      .catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
    if (!info.id) {
      throw this.refusal(ERRORS.identityUnknown(reasonOf({ kind: 'format' })));
    }
    if (info.id !== ticket.id) {
      throw this.refusal(ERRORS.identity);
    }
    await this.send(slot, ticket, { sendBy, answerBy, check });
  }

  async send(slot, ticket, { sendBy, answerBy, check }) {
    const { id, plan } = ticket;
    const name = `Slide ${id}: ${plan.kind === 'move' ? `position ${plan.position}` : 'calibrate'}`;
    const options = {
      timeout: Math.max(200, answerBy - this.now()),
      sendWithin: sendBy - this.now(),
      // The very last check, right before the request leaves.
      beforeSend: () => {
        check();
        ticket.sent = true;
        this.lastSentAt.set(id, this.now());
        ticket.previousSent = this.sentMoveSeq.get(id);
        this.sentMoveSeq.set(id, Math.max(ticket.previousSent ?? 0, ticket.seq));
      },
      // API v1: the first request was answered 401 with a challenge, so it
      // did nothing: a STOP arriving now still cancels this move (review I1),
      // and it does not count as a move that left.
      onChallenge: () => {
        ticket.sent = false;
        if (this.sentMoveSeq.get(id) === ticket.seq) {
          if (ticket.previousSent === undefined) {
            this.sentMoveSeq.delete(id);
          } else {
            this.sentMoveSeq.set(id, ticket.previousSent);
          }
        }
      },
    };
    const request =
      plan.kind === 'move'
        ? this.client.setPos(this.target(slot), plan.pos, options)
        : this.client.calibrate(this.target(slot), options);
    this.inFlight.set(id, request);
    try {
      await request;
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      throw await this.commandFailed(slot, id, name, err, {
        plan,
        ticket,
        generation: ticket.generation,
      });
    } finally {
      if (this.inFlight.get(id) === request) {
        this.inFlight.delete(id);
      }
    }
    this.logger.info(`${name} sent`);
    if (this.stale(slot, ticket.generation)) {
      // Answered after the configuration changed: nothing of the old one.
      return;
    }
    this.notReached.delete(id);
    if (plan.kind === 'move' && !ticket.cancelled) {
      this.targets.set(id, plan.position);
    } else {
      // A STOP came meanwhile: no position to wait for (approval m2).
      this.targets.delete(id);
    }
    this.followUp(slot, id, ticket.generation);
  }

  /** The refusal of a command that failed after it was planned. */
  async commandFailed(slot, id, name, err, { plan, ticket, generation }) {
    const reason = reasonOf(err);
    if (!err?.sent && !err?.answered) {
      this.logger.warn(`${name} NOT sent (${reason.en})`);
      return this.refusal(err?.kind === 'late' ? ERRORS.tooSlow : ERRORS.notSent(reason));
    }
    if (this.stale(slot, generation)) {
      // Answered after the configuration changed: told as it is, but nothing
      // of the old configuration is paused, read or written (review I3).
      return this.refusal(err.answered ? ERRORS.refused(reason) : ERRORS.sentUnconfirmed(reason));
    }
    if (PAUSE_KINDS.has(err?.kind)) {
      await this.pause(slot, err);
    }
    this.followUp(slot, id, generation);
    if (err.answered) {
      // The Slide answered with a refusal: nothing done. Never a block from a
      // command (the reads decide that).
      this.logger.warn(`${name} refused (${reason.en})`);
      return this.refusal(ERRORS.refused(reason));
    }
    // A silence, a dropped connection, a 5xx, an answer not understood: it
    // may have been done: confirmed only by a read of the position asked.
    this.unconfirmed.add(id);
    if (plan?.kind === 'move' && !ticket?.cancelled) {
      this.targets.set(id, plan.position);
    }
    this.badges = undefined;
    this.publishBadges().catch(() => {});
    this.logger.warn(`${name} sent, NOT confirmed (${reason.en})`);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /**
   * STOP: never behind the lane nor a read, through a pause or a block (one
   * try), with the identity kept in /data before the first read. Every move
   * of that Slide not sent yet is cancelled first, even when this STOP fails;
   * a move leaving meanwhile is followed by a second STOP.
   */
  async stopNow(id, received) {
    // Every move of that Slide is cancelled: one not sent yet never leaves,
    // and one whose first request was only the probe of API v1 (answered 401,
    // nothing done) never sends its authenticated request (review I1). A
    // request already written is not undone: a second STOP follows it.
    for (const pending of this.tickets.get(id) ?? []) {
      pending.cancelled = true;
    }
    this.targets.delete(id);
    this.notReached.delete(id);
    const slot = this.slotOf(id);
    if (!slot) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const generation = this.generation;
    this.commandSeq += 1;
    const stopSeq = this.commandSeq;
    const leaving = this.inFlight.get(id);
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    try {
      await this.client.stop(this.target(slot), {
        timeout: Math.max(200, answerBy - this.now()),
        sendWithin: sendBy - this.now(),
        beforeSend: () => this.lastSentAt.set(id, this.now()),
      });
    } catch (err) {
      if (leaving) {
        this.reaffirmStop(slot, id, leaving, stopSeq);
      }
      throw await this.commandFailed(slot, id, `Slide ${id}: stop`, err, { generation });
    }
    this.logger.info(`Slide ${id}: stop sent`);
    if (leaving) {
      this.reaffirmStop(slot, id, leaving, stopSeq);
    }
    this.followUp(slot, id, generation);
  }

  /** The refusal of a command whose configuration changed meanwhile (approval m3). */
  staleRefusal(slot) {
    return this.slots.get(slot.key) === slot ? ERRORS.configChanged : ERRORS.unknownDevice;
  }

  /** Whether a slot belongs to a replaced configuration (or `generation` is an old one). */
  stale(slot, generation) {
    return generation !== this.generation || this.slots.get(slot.key) !== slot;
  }

  /**
   * A move was leaving when the STOP came: once it is answered, STOP again
   * (one try), unless a move of that Slide asked after the STOP has LEFT: the
   * user wants it, the second STOP would stop it (approval m1). A newer move
   * still waiting is awaited first: left -> no second STOP; refused or not
   * sent -> the second STOP goes (review 3: in doubt, STOP).
   */
  reaffirmStop(slot, id, leaving, stopSeq) {
    const generation = this.generation;
    const newer = () => (this.sentMoveSeq.get(id) ?? 0) > stopSeq;
    const waiting = () =>
      [...(this.tickets.get(id) ?? [])]
        .filter((t) => t.seq > stopSeq && !t.finished)
        .map((t) => t.done);
    Promise.resolve(leaving)
      .catch(() => {})
      .then(async () => {
        // Each newer move ends within its 4.3 s; new ones may arrive meanwhile.
        for (let list = waiting(); list.length > 0 && !newer(); list = waiting()) {
          await Promise.all(list);
        }
        if (this.stale(slot, generation)) {
          return;
        }
        if (newer()) {
          this.logger.info(`Slide ${id}: second stop not sent, a move sent after the stop`);
          return;
        }
        try {
          await this.client.stop(this.target(slot), {
            timeout: TIMINGS.commandAnswerBy,
            beforeSend: () => {
              if (newer()) {
                const skipped = new Error('a move was sent after the stop');
                skipped.skipped = true;
                throw skipped;
              }
              this.lastSentAt.set(id, this.now());
            },
          });
          this.logger.info(`Slide ${id}: stop sent again after a move that was leaving`);
        } catch (err) {
          if (err?.skipped) {
            this.logger.info(`Slide ${id}: second stop not sent, a move sent after the stop`);
            return;
          }
          this.logger.warn(`Slide ${id}: second stop failed (${reasonOf(err).en})`);
        }
        this.followUp(slot, id, generation);
      });
  }

  /**
   * Reads after a command, spaced over the travel of the curtain; one series
   * per Slide (a new command replaces it). After the last one, a position
   * asked and not read is shown on the badge.
   */
  followUp(slot, id, generation = this.generation) {
    if (this.stale(slot, generation)) {
      return;
    }
    for (const handle of this.followUps.get(id) ?? []) {
      this.timers.clearTimeout(handle);
    }
    const handles = new Set();
    this.followUps.set(id, handles);
    TIMINGS.followUps.forEach((delay, index) => {
      const last = index === TIMINGS.followUps.length - 1;
      const handle = this.timers.setTimeout(() => {
        handles.delete(handle);
        if (this.stale(slot, generation) || this.pauseOf(slot) || this.blockOf(slot)) {
          return;
        }
        this.readSlot(slot, generation)
          .then(async () => {
            if (this.stale(slot, generation)) {
              return;
            }
            if (last && this.targets.has(id)) {
              // The travel is over and the position asked was never read.
              this.targets.delete(id);
              if (this.positions.has(id)) {
                this.notReached.set(id, this.positions.get(id));
                this.unconfirmed.delete(id);
              }
              this.badges = undefined;
            }
            await this.publishAll();
          })
          .catch(() => this.logger.error('Refresh failed'));
      }, delay);
      handles.add(handle);
    });
  }
}
