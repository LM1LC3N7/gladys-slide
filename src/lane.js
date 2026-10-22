// -----------------------------------------------------------------------------
// The lane of one Slide: one request at a time (a small Wi-Fi device), the
// moves before the reads. A read holds the lane 2 s at most (its timeout), so
// a move arriving behind it still leaves within its 3.5 s. A STOP never takes
// the lane: it is sent at once, on its own connection (src/app.js).
// -----------------------------------------------------------------------------

export const PRIORITY = { command: 0, read: 1 };

export class Lane {
  constructor() {
    this.waiting = [];
    this.busy = false;
  }

  /** Runs `task` when the lane is free and nothing of a higher priority waits. */
  run(priority, task) {
    return new Promise((resolve, reject) => {
      const entry = { priority, task, resolve, reject };
      const at = this.waiting.findIndex((w) => w.priority > priority);
      if (at === -1) {
        this.waiting.push(entry);
      } else {
        this.waiting.splice(at, 0, entry);
      }
      this.pump();
    });
  }

  pump() {
    if (this.busy || this.waiting.length === 0) {
      return;
    }
    const next = this.waiting.shift();
    this.busy = true;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }
}
