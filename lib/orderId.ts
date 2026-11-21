/**
 * Checkout order_id generator: ORD-<ms> with per-process strictly increasing ms.
 * Format unchanged (HARDEN-01 collision safety).
 */

let lastMs = 0;
let clock: () => number = () => Date.now();

export function nextOrderId(): string {
  const now = clock();
  const ms = Math.max(now, lastMs + 1);
  lastMs = ms;
  return `ORD-${ms}`;
}

/** Test-only: inject clock (null restores Date.now). */
export function setOrderIdClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/** Test-only: reset monotonic state. */
export function resetOrderIdStateForTests(): void {
  lastMs = 0;
}
