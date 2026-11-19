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
  it("start(): exact URL, method, Authorization shape, To=E.164 + Channel=sms by default", async () => {
    delete process.env.OTP_CHANNEL;
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
    assert.equal(form.Channel, "sms");
  });

  it("start(): Channel=whatsapp only when OTP_CHANNEL=whatsapp", async () => {
    const prevChannel = process.env.OTP_CHANNEL;
    process.env.OTP_CHANNEL = "whatsapp";
    try {
      const calls: CapturedCall[] = [];
      const fetchImpl = async (url: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: String(init?.method || "GET"),
          authHeader: null,
          contentType: null,
          body: String(init?.body || ""),
        });
        return new Response(JSON.stringify({ sid: SAMPLE_VE_SID }), { status: 201 });
      };
      const p = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetchImpl as typeof fetch
      );
      await p.start(SAMPLE_PHONE, "login");
      assert.equal(parseForm(calls[0].body).Channel, "whatsapp");
    } finally {
      if (prevChannel === undefined) delete process.env.OTP_CHANNEL;
      else process.env.OTP_CHANNEL = prevChannel;
    }
  });

  it("invalid OTP_CHANNEL defaults to sms and warns once without the value", async () => {
    const prevChannel = process.env.OTP_CHANNEL;
    const bad = "not-sms-AC-secret-923009998877";
    process.env.OTP_CHANNEL = bad;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      resetOtpProviderCache();
      const calls: string[] = [];
      const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
        calls.push(String(init?.body || ""));
        return new Response(JSON.stringify({ sid: SAMPLE_VE_SID }), { status: 201 });
      };
      const p = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetchImpl as typeof fetch
      );
      await p.start(SAMPLE_PHONE, "cod_checkout");
      await p.start(SAMPLE_PHONE, "cod_checkout");
      assert.equal(parseForm(calls[0]).Channel, "sms");
      assert.equal(parseForm(calls[1]).Channel, "sms");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /OTP_CHANNEL_INVALID/);
      assert.equal(warnings[0].includes(bad), false);
      assert.equal(warnings[0].includes(SAMPLE_PHONE), false);
      assert.equal(warnings[0].includes(AUTH_TOKEN), false);
    } finally {
      console.warn = origWarn;
      if (prevChannel === undefined) delete process.env.OTP_CHANNEL;
      else process.env.OTP_CHANNEL = prevChannel;
    }
  });

  it("maps Twilio failures to generic tokens and does not log phone, code, or provider text", async () => {
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.info = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    delete process.env.OTP_CHANNEL;
    try {
      const leakBody = JSON.stringify({
        code: 60200,
        message: "Invalid parameter: To",
        more_info: "https://www.twilio.com/docs/errors/60200",
        to: SAMPLE_PHONE,
        code_value: SAMPLE_CODE,
      });
      const fetch400 = async () => new Response(leakBody, { status: 400, headers: { "Content-Type": "application/json" } });
      const p = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetch400 as typeof fetch
      );
      await assert.rejects(() => p.start(SAMPLE_PHONE, "cod_checkout"), /OTP_NUMBER_REJECTED/);

      const fetch429 = async () => new Response(JSON.stringify({ code: 60203, message: "Max send attempts reached" }), { status: 429 });
      const p429 = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetch429 as typeof fetch
      );
      await assert.rejects(() => p429.start(SAMPLE_PHONE, "cod_checkout"), /OTP_MAX_ATTEMPTS/);

      const fetchFraud = async () => new Response(JSON.stringify({ code: 60410, message: "blocked " + SAMPLE_PHONE }), { status: 403 });
      const pFraud = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetchFraud as typeof fetch
      );
      await assert.rejects(() => pFraud.start(SAMPLE_PHONE, "login"), /OTP_NUMBER_REJECTED/);

      const fetchGeo = async () => new Response(JSON.stringify({ code: 60605, message: "geo " + AUTH_TOKEN }), { status: 403 });
      const pGeo = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetchGeo as typeof fetch
      );
      await assert.rejects(() => pGeo.start(SAMPLE_PHONE, "login"), /OTP_NUMBER_REJECTED/);

      const fetchCheckMax = async () => new Response(JSON.stringify({ code: 60202, message: "max checks " + SAMPLE_CODE }), { status: 429 });
      const pCheck = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetchCheckMax as typeof fetch
      );
      await assert.rejects(() => pCheck.check(SAMPLE_VE_SID, SAMPLE_CODE), /OTP_MAX_ATTEMPTS/);

      const fetchClass = async () => new Response("upstream unavailable", { status: 503 });
      const pClass = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetchClass as typeof fetch
      );
      await assert.rejects(() => pClass.start(SAMPLE_PHONE, "cod_checkout"), /OTP_PROVIDER_START_FAILED/);

      const fetchUnknown400 = async () => new Response(JSON.stringify({ message: "nope " + SAMPLE_PHONE }), { status: 400 });
      const pUnknown = createTwilioVerifyProvider(
        { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
        fetchUnknown400 as typeof fetch
      );
      await assert.rejects(() => pUnknown.start(SAMPLE_PHONE, "cod_checkout"), /OTP_NUMBER_REJECTED/);
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      console.info = orig.info;
    }
    const blob = logs.join("\n");
    assert.equal(blob.includes(SAMPLE_PHONE), false);
    assert.equal(blob.includes(SAMPLE_CODE), false);
    assert.equal(blob.includes(AUTH_TOKEN), false);
    assert.equal(blob.includes(ACCOUNT_SID), false);
    assert.equal(blob.includes(SERVICE_SID), false);
    assert.equal(blob.includes("Invalid parameter"), false);
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
