import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

// lib/*.ts uses extensionless relative imports (Next convention); map them to .ts for node --test.
installTsResolveHook();
const { createMockOtpProvider } = await import("../lib/otp/mockProvider.ts");
const { createTwilioVerifyProvider } = await import("../lib/otp/twilioVerifyProvider.ts");
const { getOtpProvider, isOtpProviderConfigured, otpIsEffective, resetOtpProviderCache } = await import(
  "../lib/otp/index.ts"
);

const prev = { ...process.env };
// NODE_ENV is typed read-only by Next's env typings; the tests need to flip it.
const mutableEnv = process.env as Record<string, string | undefined>;

/** Fixed Verification SID shape (VE + 32 hex). */
const SAMPLE_VE_SID = "VE" + "a".repeat(32);
const SAMPLE_PHONE = "+923331234567";
const SAMPLE_CODE = "123456";
const SERVICE_SID = "VA" + "b".repeat(32);
const ACCOUNT_SID = "AC" + "c".repeat(32);
const AUTH_TOKEN = "test-auth-token-value";
const EXPECTED_START_URL = `https://verify.twilio.com/v2/Services/${encodeURIComponent(SERVICE_SID)}/Verifications`;
const EXPECTED_CHECK_URL = `https://verify.twilio.com/v2/Services/${encodeURIComponent(SERVICE_SID)}/VerificationCheck`;

type CapturedCall = {
  url: string;
  method: string;
  authHeader: string | null;
  contentType: string | null;
  body: string;
};

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function assertAuthHeaderShape(header: string | null) {
  assert.ok(header, "Authorization header present");
  assert.ok(header.startsWith("Basic "), "Authorization uses Basic scheme");
  const b64 = header.slice("Basic ".length);
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(b64), "Basic credentials are base64-shaped");
  assert.ok(b64.length > 8, "Basic credentials non-empty");
  // Do not assert or log decoded accountSid/authToken values.
}

describe("mock OTP provider", () => {
  it("accepts 000000 and refuses production construct", async () => {
    const prevEnv = process.env.NODE_ENV;
    mutableEnv.NODE_ENV = "test";
    const p = createMockOtpProvider();
    const started = await p.start("+923331234567", "cod_checkout");
    assert.ok(started.providerRef.startsWith("mock:"));
    assert.equal(await p.check(started.providerRef, "000000"), true);
    assert.equal(await p.check(started.providerRef, "111111"), false);
    mutableEnv.NODE_ENV = "production";
    assert.throws(() => createMockOtpProvider(), /OTP_MOCK_REFUSED_IN_PRODUCTION/);
    mutableEnv.NODE_ENV = prevEnv;
  });
});

describe("twilio_verify provider (mocked fetch)", () => {
  it("start(): exact URL, method, Authorization shape, To=E.164 + Channel=whatsapp", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        url: String(url),
        method: String(init?.method || "GET"),
        authHeader: headers?.Authorization ?? null,
        contentType: headers?.["Content-Type"] ?? null,
        body: String(init?.body || ""),
      });
      return new Response(JSON.stringify({ sid: SAMPLE_VE_SID }), { status: 201 });
    };
    const p = createTwilioVerifyProvider(
      { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
      fetchImpl as typeof fetch
    );
    const started = await p.start(SAMPLE_PHONE, "cod_checkout");
    assert.equal(started.providerRef, SAMPLE_VE_SID);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, EXPECTED_START_URL);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].contentType, "application/x-www-form-urlencoded");
    assertAuthHeaderShape(calls[0].authHeader);
    const form = parseForm(calls[0].body);
    assert.deepEqual(Object.keys(form).sort(), ["Channel", "To"]);
    assert.equal(form.To, SAMPLE_PHONE);
    assert.equal(form.Channel, "whatsapp");
  });

  it("check(): VerificationSid + Code when ref is a Verification SID (never To=SID)", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        url: String(url),
        method: String(init?.method || "GET"),
        authHeader: headers?.Authorization ?? null,
        contentType: headers?.["Content-Type"] ?? null,
        body: String(init?.body || ""),
      });
      return new Response(JSON.stringify({ status: "approved" }), { status: 200 });
    };
    const p = createTwilioVerifyProvider(
      { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
      fetchImpl as typeof fetch
    );
    assert.equal(await p.check(SAMPLE_VE_SID, SAMPLE_CODE), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, EXPECTED_CHECK_URL);
    assert.equal(calls[0].method, "POST");
    assertAuthHeaderShape(calls[0].authHeader);
    const form = parseForm(calls[0].body);
    assert.deepEqual(Object.keys(form).sort(), ["Code", "VerificationSid"]);
    assert.equal(form.VerificationSid, SAMPLE_VE_SID);
    assert.equal(form.Code, SAMPLE_CODE);
    assert.equal(form.To, undefined);
  });

  it("check(): To=E.164 + Code when a phone is passed (not a SID)", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        url: String(url),
        method: String(init?.method || "GET"),
        authHeader: headers?.Authorization ?? null,
        contentType: headers?.["Content-Type"] ?? null,
        body: String(init?.body || ""),
      });
      return new Response(JSON.stringify({ status: "approved" }), { status: 200 });
    };
    const p = createTwilioVerifyProvider(
      { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
      fetchImpl as typeof fetch
    );
    assert.equal(await p.check(SAMPLE_PHONE, SAMPLE_CODE), true);
    const form = parseForm(calls[0].body);
    assert.deepEqual(Object.keys(form).sort(), ["Code", "To"]);
    assert.equal(form.To, SAMPLE_PHONE);
    assert.equal(form.Code, SAMPLE_CODE);
    assert.equal(form.VerificationSid, undefined);
  });

  it("status mapping: approved -> true; pending/denied/HTTP error/network error -> false", async () => {
    async function checkWith(fetchImpl: typeof fetch) {
      const p = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetchImpl
      );
      return p.check(SAMPLE_VE_SID, SAMPLE_CODE);
    }

    assert.equal(
      await checkWith(async () => new Response(JSON.stringify({ status: "approved" }), { status: 200 }) as Response),
      true
    );
    assert.equal(
      await checkWith(async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }) as Response),
      false
    );
    assert.equal(
      await checkWith(async () => new Response(JSON.stringify({ status: "denied" }), { status: 200 }) as Response),
      false
    );
    assert.equal(await checkWith(async () => new Response("nope", { status: 500 }) as Response), false);
    assert.equal(
      await checkWith(async () => {
        throw new Error("network");
      }),
      false
    );
  });

  it("start() failure throws; incomplete config throws", async () => {
    const failFetch = async () => new Response("nope", { status: 500 });
    const p = createTwilioVerifyProvider(
      { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
      failFetch as typeof fetch
    );
    await assert.rejects(() => p.start(SAMPLE_PHONE, "cod_checkout"), /OTP_PROVIDER_START_FAILED/);
    assert.throws(
      () => createTwilioVerifyProvider({ accountSid: "", authToken: AUTH_TOKEN, serviceSid: SERVICE_SID }),
      /OTP_TWILIO_CONFIG_INCOMPLETE/
    );
  });
});

describe("otp loader", () => {
  beforeEach(() => {
    resetOtpProviderCache();
    process.env.OTP_PROVIDER = "";
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;
  });
  afterEach(() => {
    resetOtpProviderCache();
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  });

  it("treats missing provider as not effective", () => {
    assert.equal(isOtpProviderConfigured(), false);
    assert.equal(otpIsEffective(true), false);
    assert.equal(getOtpProvider(), null);
  });

  it("loads mock when configured and not production", () => {
    mutableEnv.NODE_ENV = "test";
    process.env.OTP_PROVIDER = "mock";
    assert.equal(isOtpProviderConfigured(), true);
    assert.equal(otpIsEffective(true), true);
    assert.equal(getOtpProvider()?.name, "mock");
  });
});
