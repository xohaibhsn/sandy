/**
 * Dashboard summary retry (BATCH-12 H1 / finding 49) — mocked fetch, no DB, no React.
 *
 * Drives the real adminRequest through a mocked global fetch to prove: retry ONCE on
 * network error / 5xx, success on retry, error after a failed retry, and no retry on 4xx.
 *
 * Run: node --test tests/dashboard-summary-retry.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { fetchDashboardSummaryWithRetry, isTransientDashboardFailure, DASHBOARD_SUMMARY_RETRY_DELAY_MS } = await import(
  "../lib/dashboardSummaryFetch.ts"
);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = "/api/admin-dashboard-summary?preset=all";
const realFetch = globalThis.fetch;

type Step = { status: number; body?: unknown } | "network-error";

function mockFetch(steps: Step[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function fakeSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchDashboardSummaryWithRetry", () => {
  it("retries once after ~1.5s on network error, then succeeds", async () => {
    const calls = mockFetch(["network-error", { status: 200, body: { success: true, total_orders: 3 } }]);
    const { delays, sleep } = fakeSleep();
    const res = await fetchDashboardSummaryWithRetry<{ success?: boolean; total_orders?: number }>(URL_, { sleep });
    assert.equal(calls.length, 2);
    assert.deepEqual(delays, [1500]);
    assert.equal(DASHBOARD_SUMMARY_RETRY_DELAY_MS, 1500);
    assert.equal(res.ok, true);
    assert.equal(res.data.total_orders, 3);
  });

  it("retries once on 5xx, then succeeds", async () => {
    const calls = mockFetch([{ status: 500, body: { error: "Could not load dashboard summary" } }, { status: 200, body: { success: true } }]);
    const { delays, sleep } = fakeSleep();
    const res = await fetchDashboardSummaryWithRetry(URL_, { sleep });
    assert.equal(calls.length, 2);
    assert.deepEqual(delays, [1500]);
    assert.equal(res.ok, true);
  });

  it("retries once on 5xx, then fails -> final error surfaced (exactly 2 calls, never 3)", async () => {
    const calls = mockFetch([{ status: 503, body: { error: "Could not load dashboard summary" } }]);
    const { delays, sleep } = fakeSleep();
    const res = await fetchDashboardSummaryWithRetry(URL_, { sleep });
    assert.equal(calls.length, 2);
    assert.equal(delays.length, 1);
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(res.errorMessage, "Could not load dashboard summary");
  });

  it("network error then network error -> one retry then the network-error message", async () => {
    const calls = mockFetch(["network-error"]);
    const { sleep } = fakeSleep();
    const res = await fetchDashboardSummaryWithRetry(URL_, { sleep });
    assert.equal(calls.length, 2);
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.equal(res.errorMessage, "Network error. Please try again.");
  });

  it("does NOT retry on 401/403 or other 4xx", async () => {
    for (const status of [400, 401, 403, 404, 429]) {
      const calls = mockFetch([{ status, body: { error: "nope" } }]);
      const { delays, sleep } = fakeSleep();
      const res = await fetchDashboardSummaryWithRetry(URL_, { sleep });
      assert.equal(calls.length, 1, `status ${status} must not retry`);
      assert.equal(delays.length, 0);
      assert.equal(res.ok, false);
      assert.equal(res.status, status);
      assert.equal(res.sessionExpired, status === 401 || status === 403);
    }
  });

  it("does not retry on success, or on 200 with success:false", async () => {
    let calls = mockFetch([{ status: 200, body: { success: true } }]);
    await fetchDashboardSummaryWithRetry(URL_, { sleep: fakeSleep().sleep });
    assert.equal(calls.length, 1);
    calls = mockFetch([{ status: 200, body: { success: false, error: "x" } }]);
    await fetchDashboardSummaryWithRetry(URL_, { sleep: fakeSleep().sleep });
    assert.equal(calls.length, 1);
  });

  it("skips the retry when cancelled during the delay", async () => {
    const calls = mockFetch([{ status: 500 }, { status: 200, body: { success: true } }]);
    const res = await fetchDashboardSummaryWithRetry(URL_, { sleep: fakeSleep().sleep, isCancelled: () => true });
    assert.equal(calls.length, 1);
    assert.equal(res.ok, false);
  });

  it("isTransientDashboardFailure: only network (0) and 5xx", () => {
    assert.equal(isTransientDashboardFailure({ ok: false, status: 0 }), true);
    assert.equal(isTransientDashboardFailure({ ok: false, status: 500 }), true);
    assert.equal(isTransientDashboardFailure({ ok: false, status: 599 }), true);
    assert.equal(isTransientDashboardFailure({ ok: false, status: 401 }), false);
    assert.equal(isTransientDashboardFailure({ ok: false, status: 404 }), false);
    assert.equal(isTransientDashboardFailure({ ok: true, status: 200 }), false);
  });
});

describe("wiring + server logging hygiene", () => {
  it("DashboardCards uses the retry helper for the summary fetch", () => {
    const src = readFileSync(path.join(repoRoot, "components", "admin", "DashboardCards.tsx"), "utf8");
    assert.match(src, /fetchDashboardSummaryWithRetry/);
    assert.doesNotMatch(src, /adminRequest<DashboardSummary>\(`\/api\/admin-dashboard-summary/);
  });

  it("admin-dashboard-summary logs only an error CODE", () => {
    const src = readFileSync(path.join(repoRoot, "pages", "api", "admin-dashboard-summary.ts"), "utf8");
    assert.match(src, /console\.error\("DASHBOARD_SUMMARY_ERROR", code\)/);
    assert.doesNotMatch(src, /console\.error\([^)]*(?:message|stack|\.msg|msg\.)/);
    assert.doesNotMatch(src, /\[admin-dashboard-summary\]/);
  });
});
