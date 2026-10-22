// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration), the vocabulary of the Slide local API and the tuning of the
// integration.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** Languages of the feature names (manifest `language` options). */
export const LANGUAGES = ['fr', 'en'];

/** Bounds of the read interval (seconds), mirrored by the manifest. */
export const POLL_INTERVAL = { min: 10, max: 3600, default: 30 };

/** At most this many Slides in the configuration. */
export const MAX_SLIDES = 8;

/**
 * The local API of the Slide (published by Innovation in Motion, and
 * goslide-api `GoSlideLocal`, Apache-2.0): a POST of JSON to
 * http://<slide>/rpc/<method>. API v2 has no authentication; API v1 (older
 * firmware) answers 401 with an HTTP Digest challenge (user "user", the device
 * code printed on the Slide as the password).
 */
export const API = {
  user: 'user',
  info: '/rpc/Slide.GetInfo',
  setPos: '/rpc/Slide.SetPos',
  stop: '/rpc/Slide.Stop',
  calibrate: '/rpc/Slide.Calibrate',
};

/** The feature keys (frozen: the external ids end with them). */
export const FEATURES = {
  STATE: 'state',
  POSITION: 'position',
  CALIBRATE: 'calibrate',
};

/** Gladys COVER_STATE values (curtain `state`). */
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };

/** Gladys BUTTON_PUSH: the one value of a `button/push` command. */
export const PRESSED = 1;

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin for the other paths. */
  statesPerMinute: 250,
  /** Size of an answer of the Slide (GetInfo is a few hundred bytes). */
  responseBytes: 16 * 1024,
  /** Size of a WWW-Authenticate header taken into account. */
  challengeBytes: 1024,
  /** Characters of a name read from the Slide kept in Gladys. */
  name: 60,
  /** Characters of a device code. */
  code: 64,
  /** Characters of a transport badge message (SDK limit). */
  badgeMessage: 200,
  /** Distance (in Gladys percent) under which a position read equals the one asked. */
  positionTolerance: 2,
};

export const TIMINGS = {
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * MINUTE,
  /**
   * One read (the whole exchange, the Digest challenge included). It holds
   * the lane of the Slide: a move arriving behind it still leaves in time.
   */
  readTimeout: 2 * SECOND,
  /** The last read time is written to /data at most this often. */
  attemptPersistEvery: MINUTE,
  /** Delays after a failure of a Slide (never sooner than the interval). */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** Bounds of the pause after a 429 or a 5xx (Retry-After, or doubled from the min). */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /**
   * Gladys acks a set_value within 5 s: a command not sent within 3.5 s of
   * its arrival is refused, never sent late; its answer is awaited until 4.3 s.
   */
  commandSendBy: 3500,
  commandAnswerBy: 4300,
  /** The identity read of a move must leave this much time for the move itself. */
  commandSendMargin: 300,
  /** A Slide is read again at these delays after a command (a curtain moves for up to a minute). */
  followUps: [2 * SECOND, 8 * SECOND, 20 * SECOND, 45 * SECOND],
};
