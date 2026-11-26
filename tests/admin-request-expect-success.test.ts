/**
 * BATCH-60 H-2: adminRequest expectSuccess behaviour for flat JSON maps (site-content GET).
 * Mock fetch only — no network, no DB.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { adminRequest } = await import("../lib/adminRequest.ts");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockJson(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("adminRequest expectSuccess", () => {
  it("200 JSON map without success is ok when expectSuccess:false", async () => {
    mockJson(200, { invoice_business_name: "S&Y", invoice_ntn: "123" });
    const res = await adminRequest<Record<string, string>>("/api/site-content", undefined, {
      expectSuccess: false,
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.data.invoice_business_name, "S&Y");
    assert.equal(res.errorMessage, "");
  });

  it("200 JSON map without success is NOT ok when expectSuccess defaults true", async () => {
    mockJson(200, { invoice_business_name: "S&Y", invoice_ntn: "123" });
    const res = await adminRequest<Record<string, string>>("/api/site-content");
    assert.equal(res.ok, false);
    assert.equal(res.status, 200);
    assert.equal(res.errorMessage, "Request failed");
  });
});
