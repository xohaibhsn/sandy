/**
 * SANDY-BATCH-34 — admin OTP health (no-SMS) DB/API integration.
 *
 * Real handler in-process against sandy_mig_orders (127.0.0.1:3307).
 * All Twilio calls use an injected fake fetch; any non-fake URL throws.
 *
 * Env: SANDY_TEST_DB_PASSWORD (required, never printed).
 * Run: node tests/admin-otp-health-db.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  adminReq,
  createPool,
  ensureTestMasterLoginEnv,
  importFromRoot,
  installTsResolveHook,
  invoke,
  makeAssertions,
  one,
  rebuildFromMigrations,
  requirePassword,
  root,
  runSqlOnTestDb,
  applyDeliveryOpsMigration,
  count,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.NODE_ENV = "test";

/** Runtime-built secrets so secrets-gate / evidence never see fixed literals. */
const FAKE_ACCOUNT = "AC" + crypto.randomBytes(16).toString("hex");
const FAKE_SERVICE = "VA" + crypto.randomBytes(16).toString("hex");
const FAKE_TOKEN = crypto.randomBytes(16).toString("hex");
const FAKE_FRIENDLY = "TestVerifySvc" + crypto.randomBytes(2).toString("hex");

await rebuildFromMigrations();
await applyDeliveryOpsMigration();
await runSqlOnTestDb(readFileSync(path.join(root, "migrations/0011-admin-audit-log.sql"), "utf8"));

const pool = createPool();
globalThis._mysqlPool = pool;

const { resetAuditSchemaProbeForTests, resetAuditThrottleForTests } = await importFromRoot("lib/auditLog.ts");
const { resetOtpProviderCache } = await importFromRoot("lib/otp/index.ts");

const healthMod = await importFromRoot("pages/api/admin-otp-health.ts");
const healthHandler = healthMod.default;
const { __setAdminOtpHealthFetchForTests, __resetAdminOtpHealthRateLimitForTests } = healthMod;

const otpStartHandler = (await importFromRoot("pages/api/checkout/otp-start.ts")).default;
const { resetOrderProtectionSettingsCache, ORDER_PROTECTION_KEYS } = await importFromRoot(
  "lib/orderProtectionSettings.ts"
);

const { eq, ok, total } = makeAssertions(assert);
const sections = [];
async function section(name, fn) {
  try {
    await fn();
    sections.push(name);
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}

function assertNoSecretLeak(blob) {
  // Friendly name is intentionally returned; never Account SID / Auth Token / Service SID.
  for (const s of [FAKE_ACCOUNT, FAKE_SERVICE, FAKE_TOKEN]) {
    ok(!String(blob).includes(s), "response/audit must not contain fake secret values");
  }
}

async function mintToken(role) {
  ensureTestMasterLoginEnv();
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await pool.query(
    "INSERT INTO admin_sessions (token_hash, staff_id, is_master, role, name, expires_at) VALUES (?,?,?,?,?,?)",
    [hash, null, role === "super_admin" ? 1 : 0, role, `otp-health-${role}`, expires]
  );
  return raw;
}

function admin(handler, token, { method = "POST", url = "/api/admin-otp-health", body = {}, headers = {} } = {}) {
  const base = token
    ? adminReq(token)
    : { cookies: {}, headers: { origin: "http://orders.test" } };
  return invoke(handler, {
    method,
    url,
    body,
    cookies: base.cookies,
    headers: { ...base.headers, ...headers },
  });
}

function installStrictFetch(impl) {
  const wrapped = async (url, init) => {
    const u = String(url);
    if (!u.startsWith("https://verify.twilio.com/v2/Services/")) {
      throw new Error(`NO_NETWORK: unexpected URL ${u.slice(0, 40)}`);
    }
    return impl(url, init);
  };
  __setAdminOtpHealthFetchForTests(wrapped);
  return wrapped;
}

async function setOtpEnv(complete) {
  if (complete) {
    process.env.OTP_PROVIDER = "twilio_verify";
    process.env.TWILIO_ACCOUNT_SID = FAKE_ACCOUNT;
    process.env.TWILIO_AUTH_TOKEN = FAKE_TOKEN;
    process.env.TWILIO_VERIFY_SERVICE_SID = FAKE_SERVICE;
  } else {
    process.env.OTP_PROVIDER = "twilio_verify";
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;
  }
  resetOtpProviderCache();
}

async function clearAudit() {
  await pool.query("DELETE FROM admin_audit_log");
  resetAuditThrottleForTests();
  resetAuditSchemaProbeForTests();
}

__resetAdminOtpHealthRateLimitForTests();
resetAuditSchemaProbeForTests();
resetAuditThrottleForTests();

await section("super_admin 200 connected path (fake GET)", async () => {
  await clearAudit();
  __resetAdminOtpHealthRateLimitForTests();
  await setOtpEnv(true);
  let fetchCalls = 0;
  installStrictFetch(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ friendly_name: FAKE_FRIENDLY, sid: FAKE_SERVICE }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const token = await mintToken("super_admin");
  const res = await admin(healthHandler, token);
  eq(res.statusCode, 200);
  eq(res.body.ok, true);
  eq(res.body.stage, "twilio");
  eq(res.body.http, 200);
  eq(fetchCalls, 1);
  ok(String(res.body.hint || "").includes("Connected to Twilio Verify service"));
  assertNoSecretLeak(JSON.stringify(res.body));
  const row = await one(
    pool,
    "SELECT action, entity_type, detail_json FROM admin_audit_log WHERE action='setting_check' ORDER BY id DESC LIMIT 1"
  );
  eq(row?.action, "setting_check");
  eq(row?.entity_type, "otp");
  assertNoSecretLeak(row?.detail_json || "");
});

await section("manager and writer forbidden", async () => {
  __resetAdminOtpHealthRateLimitForTests();
  await setOtpEnv(true);
  installStrictFetch(async () => {
    throw new Error("NO_NETWORK: must not fetch for forbidden roles");
  });
  for (const role of ["manager", "writer"]) {
    const token = await mintToken(role);
    const res = await admin(healthHandler, token);
    eq(res.statusCode, 403, role);
  }
});

await section("unauthenticated 401", async () => {
  __resetAdminOtpHealthRateLimitForTests();
  const res = await admin(healthHandler, null);
  eq(res.statusCode, 401);
});

await section("cross-origin rejected", async () => {
  __resetAdminOtpHealthRateLimitForTests();
  await setOtpEnv(true);
  const token = await mintToken("super_admin");
  const res = await admin(healthHandler, token, {
    headers: { origin: "https://evil.example" },
  });
  eq(res.statusCode, 403);
});

await section("env-missing makes no fetch", async () => {
  await clearAudit();
  __resetAdminOtpHealthRateLimitForTests();
  await setOtpEnv(false);
  let fetchCalls = 0;
  installStrictFetch(async () => {
    fetchCalls += 1;
    throw new Error("should not be called");
  });
  const token = await mintToken("super_admin");
  const res = await admin(healthHandler, token);
  eq(res.statusCode, 200);
  eq(res.body.ok, false);
  eq(res.body.stage, "env");
  eq(fetchCalls, 0);
  ok(Array.isArray(res.body.checks));
  assertNoSecretLeak(JSON.stringify(res.body));
});

await section("rate limit 6/min per session", async () => {
  __resetAdminOtpHealthRateLimitForTests();
  await setOtpEnv(false);
  installStrictFetch(async () => {
    throw new Error("no fetch");
  });
  const token = await mintToken("super_admin");
  for (let i = 0; i < 6; i++) {
    const r = await admin(healthHandler, token);
    eq(r.statusCode, 200, `call ${i + 1}`);
  }
  const blocked = await admin(healthHandler, token);
  eq(blocked.statusCode, 429);
});

await section("otp_send_failed audit throttled; no phone/secrets", async () => {
  await clearAudit();
  process.env.OTP_PROVIDER = "twilio_verify";
  process.env.TWILIO_ACCOUNT_SID = FAKE_ACCOUNT;
  process.env.TWILIO_AUTH_TOKEN = FAKE_TOKEN;
  process.env.TWILIO_VERIFY_SERVICE_SID = FAKE_SERVICE;
  resetOtpProviderCache();

  // Force provider start failure via a fake global fetch used by createTwilioVerifyProvider.
  const phone = "0333" + String(Date.now()).slice(-7);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes("verify.twilio.com")) throw new Error(`NO_NETWORK: ${u.slice(0, 40)}`);
    return new Response(JSON.stringify({ code: 20008, message: "test creds " + phone }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  };

  await pool.query("DELETE FROM site_content WHERE content_key IN (?)", [[...ORDER_PROTECTION_KEYS]]);
  await pool.query(
    "INSERT INTO site_content (content_key, content_value, content_type, page_name, label) VALUES ('cod_otp_enabled','1','text','settings','cod_otp_enabled')"
  );
  resetOrderProtectionSettingsCache();

  try {
    for (let i = 0; i < 3; i++) {
      const r = await invoke(otpStartHandler, {
        method: "POST",
        url: "/api/checkout/otp-start",
        body: { phone },
        ip: `203.0.113.${10 + i}`,
      });
      eq(r.statusCode, 400, `start ${i}`);
      eq(r.body?.error?.includes?.("rejected") || r.body?.error?.length > 0, true);
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  const n = await count(pool, "SELECT COUNT(*) AS c FROM admin_audit_log WHERE action='otp_send_failed'");
  eq(n, 1, "throttled to one audit row per kind+code per 15m");
  const row = await one(pool, "SELECT detail_json, summary FROM admin_audit_log WHERE action='otp_send_failed' LIMIT 1");
  assertNoSecretLeak(JSON.stringify(row));
  ok(!String(row?.detail_json || "").includes(phone), "no phone in audit detail");
});

__setAdminOtpHealthFetchForTests(null);
await pool.end();

console.log(
  "ADMIN_OTP_HEALTH_DB_PASS",
  JSON.stringify({ sections: sections.length, assertions: total(), noNetwork: true })
);
