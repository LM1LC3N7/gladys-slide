// -----------------------------------------------------------------------------
// The errors of the Slide client, by kind. The message is English (logs) and
// never holds an address, a code nor a body of the Slide; src/i18n.js says
// them to the user.
//
// `sent`: whether a request that could have had an effect left (its first byte
// written to a connected socket, and no answer saying it did nothing). A
// command error with `sent` false is "not sent"; with `sent` true it is "sent,
// without confirmation" (or "refused" when the Slide answered so).
// -----------------------------------------------------------------------------

export const KINDS = [
  'unreachable', // no connection (refused, no route, reset before the request)
  'timeout', // no answer in time
  'late', // the connection did not come up in time: nothing written
  'invalid', // something answered, but not in HTTP (a wrong port)
  'tooLarge', // an answer over the size cap
  'format', // an answer that is not one of a Slide
  'codeNeeded', // the Slide asks for its device code (API v1), none typed
  'auth', // the device code was refused
  'rate', // HTTP 429
  'server', // HTTP 5xx
  'http', // another HTTP status
];

export class SlideError extends Error {
  /**
   * @param {string} kind one of KINDS
   * @param {{ sent?: boolean, status?: number, retryAfter?: number }} [details]
   *   retryAfter in ms
   */
  constructor(kind, { sent = false, status, retryAfter } = {}) {
    super(status === undefined ? kind : `${kind} (HTTP ${status})`);
    this.name = 'SlideError';
    this.kind = kind;
    this.sent = sent;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After (seconds or an HTTP date) -> ms, or undefined. */
export function retryAfterOf(value, now = Date.now()) {
  if (typeof value !== 'string' || value === '' || value.length > 64) {
    return undefined;
  }
  if (/^\d{1,9}$/.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
