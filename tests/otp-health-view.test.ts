import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const { otpHealthViewFromBody } = await import("../lib/otp/healthView.ts");

const FAKE_AC = "AC" + "d".repeat(32);
const FAKE_VA = "VA" + "e".repeat(32);
const FAKE_TOKEN = "f".repeat(32);

describe("otpHealthViewFromBody", () => {
  it("maps 200 ok Connected hint and present/ok lines", () => {
    const view = otpHealthViewFromBody({
      ok: true,
      stage: "twilio",
      hint: "Connected to Twilio Verify service SandY",
      checks: [
        { name: "OTP_PROVIDER", missing: false, hadWhitespace: false, hadQuotes: false, format: "n/a" },
        { name: "TWILIO_ACCOUNT_SID", missing: false, hadWhitespace: false, hadQuotes: false, format: "ok" },
        { name: "TWILIO_AUTH_TOKEN", missing: false, hadWhitespace: false, hadQuotes: false, format: "ok" },
        { name: "TWILIO_VERIFY_SERVICE_SID", missing: false, hadWhitespace: false, hadQuotes: false, format: "ok" },
      ],
    });
    assert.equal(view.tone, "ok");
    assert.equal(view.hint, "Connected to Twilio Verify service SandY");
    assert.deepEqual(view.lines, [
      "OTP_PROVIDER: present",
      "TWILIO_ACCOUNT_SID: present, ok",
      "TWILIO_AUTH_TOKEN: present, ok",
      "TWILIO_VERIFY_SERVICE_SID: present, ok",
    ]);
  });

  it("maps stage env with missing/whitespace/quotes/bad-format flags", () => {
    const view = otpHealthViewFromBody({
      ok: false,
      stage: "env",
      checks: [
        { name: "OTP_PROVIDER", missing: false, hadWhitespace: false, hadQuotes: false, format: "n/a" },
        { name: "TWILIO_ACCOUNT_SID", missing: false, hadWhitespace: true, hadQuotes: true, format: "ok" },
        { name: "TWILIO_AUTH_TOKEN", missing: false, hadWhitespace: false, hadQuotes: false, format: "bad" },
        { name: "TWILIO_VERIFY_SERVICE_SID", missing: true, hadWhitespace: false, hadQuotes: false, format: "n/a" },
      ],
    });
    assert.equal(view.tone, "error");
    assert.match(view.hint, /OTP provider env incomplete/);
    assert.deepEqual(view.lines, [
      "OTP_PROVIDER: present",
      "TWILIO_ACCOUNT_SID: present, whitespace, quotes, ok",
      "TWILIO_AUTH_TOKEN: present, bad-format",
      "TWILIO_VERIFY_SERVICE_SID: missing",
    ]);
  });

  it("passes through 401/403/404 twilio hints as error tone", () => {
    const h401 = otpHealthViewFromBody({
      ok: false,
      stage: "twilio",
      hint: "Authentication failed: check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (use the LIVE credentials from Twilio Console -> Account Info)",
      checks: [],
    });
    assert.equal(h401.tone, "error");
    assert.match(h401.hint, /Authentication failed/);

    const h403 = otpHealthViewFromBody({
      ok: false,
      stage: "twilio",
      hint: "These look like Twilio TEST credentials; use the LIVE Account SID and Auth Token",
      checks: [],
    });
    assert.equal(h403.tone, "error");
    assert.match(h403.hint, /TEST credentials/);

    const h404 = otpHealthViewFromBody({
      ok: false,
      stage: "twilio",
      hint: "Verify Service SID not found in this Twilio account",
      checks: [],
    });
    assert.equal(h404.tone, "error");
    assert.match(h404.hint, /Verify Service SID not found/);
  });

  it("never leaks AC/VA/token-shaped strings from unexpected fields", () => {
    const view = otpHealthViewFromBody({
      ok: true,
      stage: "twilio",
      hint: "Connected to Twilio Verify service SandY",
      accountSid: FAKE_AC,
      authToken: FAKE_TOKEN,
      serviceSid: FAKE_VA,
      secret: FAKE_TOKEN,
      nested: { token: FAKE_TOKEN, sid: FAKE_AC },
      checks: [
        {
          name: "TWILIO_ACCOUNT_SID",
          missing: false,
          hadWhitespace: false,
          hadQuotes: false,
          format: "ok",
          value: FAKE_AC,
        },
      ],
    });
    const blob = JSON.stringify(view);
    assert.equal(blob.includes(FAKE_AC), false);
    assert.equal(blob.includes(FAKE_VA), false);
    assert.equal(blob.includes(FAKE_TOKEN), false);
    assert.equal(view.lines[0], "TWILIO_ACCOUNT_SID: present, ok");
  });
});
