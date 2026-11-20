import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const { readOtpEnv, sanitiseEnvRaw } = await import("../lib/otp/env.ts");
const { hintForOtpHealth } = await import("../lib/otp/healthHints.ts");
const {
  OtpProviderError,
  classifyTwilioFailure,
  otpFailureLogParts,
} = await import("../lib/otp/twilioFailure.ts");
const { createTwilioVerifyProvider } = await import("../lib/otp/twilioVerifyProvider.ts");

const prev = { ...process.env };
const mutableEnv = process.env as Record<string, string | undefined>;

const ACCOUNT_SID = "AC" + "a".repeat(32);
const SERVICE_SID = "VA" + "b".repeat(32);
const AUTH_TOKEN = "c".repeat(32);
const SAMPLE_PHONE = "+923331234567";

function assertNoLeak(blob: string, secrets: string[]) {
  for (const s of secrets) {
    assert.equal(blob.includes(s), false, `must not leak ${s.slice(0, 4)}…`);
  }
}

describe("otp env sanitiser", () => {
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  });

  it("trims whitespace and strips one pair of surrounding quotes", () => {
    const t = sanitiseEnvRaw(`  "${ACCOUNT_SID}"  \n`);
    assert.equal(t.value, ACCOUNT_SID);
    assert.equal(t.missing, false);
    assert.equal(t.hadWhitespace, true);
    assert.equal(t.hadQuotes, true);
  });

  it("reports missing and format checks without values in the report", () => {
    mutableEnv.OTP_PROVIDER = "twilio_verify";
    mutableEnv.TWILIO_ACCOUNT_SID = ` '${ACCOUNT_SID}' `;
    mutableEnv.TWILIO_AUTH_TOKEN = "not-hex-token-value!!!!!";
    delete mutableEnv.TWILIO_VERIFY_SERVICE_SID;
    const report = readOtpEnv();
    assert.equal(report.provider, "twilio_verify");
    assert.equal(report.accountSid, ACCOUNT_SID);
    assert.equal(report.authToken, "not-hex-token-value!!!!!");
    assert.equal(report.serviceSid, "");
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    assert.equal(byName.TWILIO_ACCOUNT_SID.hadQuotes, true);
    assert.equal(byName.TWILIO_ACCOUNT_SID.hadWhitespace, true);
    assert.equal(byName.TWILIO_ACCOUNT_SID.format, "ok");
    assert.equal(byName.TWILIO_AUTH_TOKEN.format, "bad");
    assert.equal(byName.TWILIO_VERIFY_SERVICE_SID.missing, true);
    assert.equal(byName.TWILIO_VERIFY_SERVICE_SID.format, "n/a");
    const json = JSON.stringify(report.checks);
    assertNoLeak(json, [ACCOUNT_SID, "not-hex-token-value", AUTH_TOKEN]);
  });

  it("marks empty / whitespace-only as missing", () => {
    const a = sanitiseEnvRaw("   ");
    assert.equal(a.missing, true);
    assert.equal(a.value, "");
    const b = sanitiseEnvRaw('""');
    assert.equal(b.missing, true);
    assert.equal(b.hadQuotes, true);
  });
});

describe("otp health hints", () => {
  it("maps 200 / 401 / 20003 / 403 / 20008 / 404 / 20404 / timeout / other", () => {
    assert.match(hintForOtpHealth({ http: 200, code: null, serviceFriendlyName: "SandY SMS" }), /Connected to Twilio Verify service SandY SMS/);
    assert.match(hintForOtpHealth({ http: 401, code: null }), /Authentication failed/);
    assert.match(hintForOtpHealth({ http: 200, code: 20003 }), /Authentication failed/);
    assert.match(hintForOtpHealth({ http: 403, code: null }), /TEST credentials/);
    assert.match(hintForOtpHealth({ http: 200, code: 20008 }), /TEST credentials/);
    assert.match(hintForOtpHealth({ http: 404, code: null }), /Service SID not found/);
    assert.match(hintForOtpHealth({ http: 500, code: 20404 }), /Service SID not found/);
    assert.equal(hintForOtpHealth({ http: null, code: null, timedOut: true }), "Could not reach Twilio");
    assert.equal(hintForOtpHealth({ http: null, code: null, networkError: true }), "Could not reach Twilio");
    assert.match(hintForOtpHealth({ http: 500, code: 99999 }), /Twilio error 99999 \(HTTP 500\)/);
  });
});

describe("OtpProviderError http/code capture", () => {
  it("carries httpStatus and twilioCode; classify still maps families", () => {
    const err = new OtpProviderError("number_rejected", 403, 20008);
    assert.equal(err.kind, "number_rejected");
    assert.equal(err.httpStatus, 403);
    assert.equal(err.twilioCode, 20008);
    assert.equal(classifyTwilioFailure(401, 20003), "failed");
    assert.equal(classifyTwilioFailure(403, 20008), "number_rejected");
    const parts = otpFailureLogParts(err);
    assert.equal(parts.kind, "number_rejected");
    assert.equal(parts.http, "403");
    assert.equal(parts.code, "20008");
  });

  it("twilio provider attaches http/code on start failure", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ code: 20003, message: "auth " + SAMPLE_PHONE }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    const p = createTwilioVerifyProvider(
      { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
      fetchImpl as typeof fetch
    );
    try {
      await p.start(SAMPLE_PHONE, "cod_checkout");
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof OtpProviderError);
      assert.equal(e.httpStatus, 401);
      assert.equal(e.twilioCode, 20003);
      assert.equal(e.kind, "start_failed");
    }
  });
});

describe("otp-start failure log shape", () => {
  beforeEach(() => {
    for (const k of ["OTP_PROVIDER", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID"]) {
      delete mutableEnv[k];
    }
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  });

  it("log line contains kind/http/code and never the phone", async () => {
    const { createOtpChallenge, resetOtpProviderCache } = await import("../lib/otp/index.ts");
    resetOtpProviderCache();
    mutableEnv.OTP_PROVIDER = "twilio_verify";
    mutableEnv.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
    mutableEnv.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    mutableEnv.TWILIO_VERIFY_SERVICE_SID = SERVICE_SID;

    const logs: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };

    // Exercise the same log helper the API uses after a provider throw.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ code: 20404, message: "missing " + SAMPLE_PHONE }), { status: 404 });
    const { createTwilioVerifyProvider: ctv } = await import("../lib/otp/twilioVerifyProvider.ts");
    const p = ctv(
      { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, serviceSid: SERVICE_SID },
      fetchImpl as typeof fetch
    );
    try {
      try {
        await p.start(SAMPLE_PHONE, "cod_checkout");
      } catch (err) {
        const parts = otpFailureLogParts(err);
        console.error(`[otp] start failed kind=${parts.kind} http=${parts.http} code=${parts.code}`);
      }
      assert.equal(logs.length, 1);
      assert.match(logs[0], /\[otp\] start failed kind=start_failed http=404 code=20404/);
      assertNoLeak(logs[0], [SAMPLE_PHONE, ACCOUNT_SID, AUTH_TOKEN, "missing"]);
    } finally {
      console.error = origError;
      resetOtpProviderCache();
      void createOtpChallenge;
    }
  });
});
