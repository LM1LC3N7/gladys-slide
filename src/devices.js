// -----------------------------------------------------------------------------
// The answers of a Slide -> plain records and Gladys devices (pure).
//
// One Gladys device per Slide, a `curtain` (never a switch nor a binary: a
// "turn everything off" never reaches it):
//   state      curtain/state     open, close, stop (write only)
//   position   curtain/position  0 closed .. 100 open (read and write)
//   calibrate  button/push       calibration, refused unless allowed
// Position: Gladys 100 = open = Slide pos 0.0; Gladys 0 = closed = pos 1.0.
//
// Identity rule (frozen: it fixes the external ids): the MAC address of
// GetInfo (`mac`, 12 hexadecimal digits); when it is missing, the 12 digits
// of `slide_id` ("slide_300000000000"). Neither: the Slide is not published
// (its identity cannot be read), and it is tried again at the next read.
//   device   ext:<selector>:slide:<12 hex digits, lower case>
//   feature  <device>:<key>
// Values from the network are copied key by key, never merged.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { cleanText } from './config.js';
import { FEATURES, LIMITS, PRESSED } from './constants.js';
import { label } from './i18n.js';

const MAC = /^[0-9a-f]{12}$/;

/** The identity of a GetInfo answer: 12 lower-case hexadecimal digits, or undefined. */
export function identityOf(json) {
  if (typeof json?.mac === 'string' && json.mac.length <= 32) {
    const mac = json.mac.replace(/[:-]/g, '').toLowerCase();
    if (MAC.test(mac)) {
      return mac;
    }
  }
  if (typeof json?.slide_id === 'string' && json.slide_id.length <= 64) {
    const match = /^slide_([0-9a-f]{12})$/i.exec(json.slide_id);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

/**
 * The position of a GetInfo answer (0 open .. 1 closed), or undefined when it
 * is not a real one. A value a hair outside (calibration drift) is clamped.
 */
export function slidePosOf(json) {
  const pos = json?.pos;
  if (typeof pos !== 'number' || !Number.isFinite(pos) || pos < -0.05 || pos > 1.05) {
    return undefined;
  }
  return Math.min(1, Math.max(0, pos));
}

/** Slide pos (0 open .. 1 closed) -> Gladys position (0 closed .. 100 open). */
export const positionOf = (pos) => Math.round((1 - pos) * 100);
/** Gladys position -> Slide pos, two decimals. */
export const slidePosFor = (position) => Math.round(100 - position) / 100;

/** A GetInfo answer as a plain record. */
export function infoOf(json) {
  const pos = slidePosOf(json);
  return {
    id: identityOf(json),
    name: cleanText(json?.device_name, LIMITS.name),
    zone: cleanText(json?.zone_name, LIMITS.name),
    position: pos === undefined ? undefined : positionOf(pos),
    touchGo: typeof json?.touch_go === 'boolean' ? json.touch_go : undefined,
    calibTime:
      Number.isSafeInteger(json?.calib_time) && json.calib_time >= 0 ? json.calib_time : undefined,
    boardRev:
      Number.isSafeInteger(json?.board_rev) && json.board_rev >= 0 ? json.board_rev : undefined,
  };
}

/** The ids of a Slide: `{ device, feature(key) }`. */
export const slideIds = (gladys, id) => gladys.externalIds('slide', id);

/** The Slide id and the feature key of an external id of this integration, or undefined. */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) {
    return undefined;
  }
  const prefix = gladys.externalIds('slide', 'x').device.slice(0, -1);
  if (!externalId.startsWith(prefix)) {
    return undefined;
  }
  const [id, key, ...rest] = externalId.slice(prefix.length).split(':');
  if (!MAC.test(id ?? '') || rest.length > 0) {
    return undefined;
  }
  return { id, key };
}

/** The name of a Slide in Gladys: its own name, else its zone, else "Slide" and the end of its MAC. */
export const nameOf = (info) => info.name || info.zone || `Slide ${info.id.slice(-6)}`;

/** The Gladys device of a Slide read. */
export function buildDevice(gladys, info, { language = 'fr' } = {}) {
  const ids = slideIds(gladys, info.id);
  const params = [{ name: 'SLIDE_MAC', value: info.id }];
  if (info.zone) {
    params.push({ name: 'SLIDE_ZONE', value: info.zone });
  }
  return {
    name: nameOf(info),
    external_id: ids.device,
    should_poll: false,
    params,
    features: [
      {
        name: label(FEATURES.STATE, language),
        external_id: ids.feature(FEATURES.STATE),
        category: C.CURTAIN,
        type: T.CURTAIN.STATE,
        min: -1,
        max: 1,
        read_only: false,
        has_feedback: false,
        keep_history: false,
      },
      {
        name: label(FEATURES.POSITION, language),
        external_id: ids.feature(FEATURES.POSITION),
        category: C.CURTAIN,
        type: T.CURTAIN.POSITION,
        min: 0,
        max: 100,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      },
      {
        name: label(FEATURES.CALIBRATE, language),
        external_id: ids.feature(FEATURES.CALIBRATE),
        category: C.BUTTON,
        type: T.BUTTON.PUSH,
        min: PRESSED,
        max: PRESSED,
        read_only: false,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };
}

/** A value of a command: a finite number, never null nor '' nor a boolean (they are not 0). */
export function numberIn(value, min, max) {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  if (value === null || value === undefined || typeof value === 'boolean') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}
