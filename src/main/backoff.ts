// The retry ladder both of this app's sockets climb: the shell's feed and the open panel's thread
// stream. Ported from T3's own connection supervisor
// (packages/client-runtime/src/connection/supervisor.ts in the T3 repo), which every T3 client uses:
// one policy, so a restarted server does not collect every client's retry in the same second, and a
// client that can never connect does not retry all day.

/** The shortest wait between attempts. */
const BASE_DELAY_MS = 1_000;

/** The longest wait: a server that stays down is checked this often, not never. */
const MAX_DELAY_MS = 30_000;

/** A connection that stayed up this long starts the ladder over; one that keeps dropping backs off. */
export const STABLE_AFTER_MS = 30_000;

export interface Backoff {
  /** The wait before the next attempt, in milliseconds; counts one more failure. */
  nextDelay(): number;
  /** Starts over, for a connection that had stayed up before it dropped. */
  reset(): void;
}

export function createBackoff(): Backoff {
  let failures = 0;

  return {
    nextDelay() {
      // Equal jitter: half the ceiling is fixed, so the wait still grows with each failure, and half
      // is random, so every client of a restarted server does not come back at once.
      const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures + 1));
      failures += 1;

      return Math.round(ceiling / 2 + (ceiling / 2) * Math.random());
    },
    reset() {
      failures = 0;
    },
  };
}
