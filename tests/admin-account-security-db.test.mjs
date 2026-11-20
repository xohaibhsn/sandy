/**
 * SANDY-BATCH-29 — ADMIN-LOGIN-02 local DB/HTTP suite (in-process handlers).
 *
 * Schema: migrations/0001–0011 + tax + delivery. DB: sandy_mig_orders @ 127.0.0.1:3307.
 * Env: SANDY_TEST_DB_PASSWORD (required, never printed).
 *
 * Run: node tests/admin-account-security-db.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createPool,
  importFromRoot,
  installTsResolveHook,
  invoke,
  makeAssertions,
  rebuildFromMigrations,
  requirePassword,
  root,
  runSqlOnTestDb,
  applyDeliveryOpsMigration,
  adminReq,
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.NODE_ENV = "test";

const MASTER_PW = ["Batch29", "Master", "Pw", crypto.randomBytes(4).toString("hex")].join("");
const STAFF_PW = ["Batch29", "Staff", "Pw", crypto.randomBytes(4).toString("hex")].join("");
const STAFF_PW_NEW = ["Batch29", "StaffNew", "Pw", crypto.randomBytes(4).toString("hex")].join("");
const WRONG_PW = ["Batch29", "Wrong", "Pw", crypto.randomBytes(4).toString("hex")].join("");
const SHORT_PW = "short";

await rebuildFromMigrations();
await applyDeliveryOpsMigration();
await runSqlOnTestDb(readFileSync(path.join(root, "migrations/0011-admin-audit-log.sql"), "utf8"));

const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const {
  resetAdminLoginGuardForTests,
  setAdminLoginGuardClockForTests,
  ADMIN_LOGIN_LOCK_BODY,
} = await importFromRoot("lib/adminLoginGuard.ts");
const { resetAuditThrottleForTests } = await importFromRoot("lib/auditLog.ts");
const { hashAdminStaffPassword } = await importFromRoot("lib/adminStaffPassword.ts");
const { createAdminSession, hashSessionToken } = await importFromRoot("lib/adminAuth.ts");
const { MASTER_PASSWORD_HOSTING_MESSAGE } = await importFromRoot("lib/adminChangePassword.ts");

const loginHandler = (await importFromRoot("pages/api/admin-login.ts")).default;
const sessionHandler = (await importFromRoot("pages/api/admin-session.ts")).default;
const changeHandler = (await importFromRoot("pages/api/admin-change-password.ts")).default;
const staffHandler = (await importFromRoot("pages/api/admin-staff.ts")).default;

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

function clearLimiters() {
  __rateLimitTestUtils.clearStore();
  resetAuditThrottleForTests();
}

function resetAll() {
  clearLimiters();
  resetAdminLoginGuardForTests();
  setAdminLoginGuardClockForTests(null);
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD_SHA256;
  delete process.env.ADMIN_PASSWORD_HASH;
}

function cookieFrom(res) {
  const raw = res.headers["set-cookie"];
  if (!raw) return null;
  const m = String(raw).match(/sAdminSession=([a-f0-9]+)/i);
  return m ? m[1] : null;
}

async function login(username, password, ip = "198.51.100.90") {
  clearLimiters();
  return invoke(loginHandler, {
    method: "POST",
    url: "/api/admin-login",
    body: { username, password },
    headers: { origin: "http://orders.test" },
    ip,
  });
}

async function sessionProbe(token) {
  return invoke(sessionHandler, {
    method: "GET",
    url: "/api/admin-session",
    cookies: token ? { sAdminSession: token } : {},
  });
}

async function changePassword(token, body, extra = {}) {
  clearLimiters();
  return invoke(changeHandler, {
    method: "POST",
    url: "/api/admin-change-password",
    body,
    ...adminReq(token, extra),
  });
}

function assertNoPwLeak(row, label) {
  const blob = JSON.stringify(row || {});
  for (const pw of [MASTER_PW, STAFF_PW, STAFF_PW_NEW, WRONG_PW]) {
    ok(!blob.includes(pw), `${label}: password value must not appear in audit`);
  }
}

async function latestAudit() {
  const [rows] = await pool.query("SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT 1");
  return Array.isArray(rows) ? rows[0] : null;
}

await section("M1: no master env → 401 + audit master_disabled (not 500)", async () => {
  resetAll();
  const r = await login("admin", WRONG_PW, "198.51.100.91");
  eq(r.statusCode, 401, JSON.stringify(r.body));
  ok(!String(r.body?.error || "").toLowerCase().includes("not configured"));
  const row = await latestAudit();
  eq(row.action, "login_failed");
  eq(JSON.parse(String(row.detail_json || "{}")).reason, "master_disabled");
  assertNoPwLeak(row, "master_disabled");
});

await section("M1: ADMIN_PASSWORD set → master login still 200", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD = MASTER_PW;
  const r = await login("admin", MASTER_PW, "198.51.100.92");
  eq(r.statusCode, 200, JSON.stringify(r.body));
  ok(cookieFrom(r));
});

await section("M2: isMaster true for master session, false for staff", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD = MASTER_PW;
  const masterLogin = await login("admin", MASTER_PW, "198.51.100.93");
  const masterTok = cookieFrom(masterLogin);
  const masterSess = await sessionProbe(masterTok);
  eq(masterSess.statusCode, 200);
  eq(masterSess.body?.authenticated, true);
  eq(masterSess.body?.isMaster, true);
  eq(masterSess.body?.role, "super_admin");
  ok(typeof masterSess.body?.name === "string");
  ok(!("staffId" in (masterSess.body || {})));
  ok(!("sessionId" in (masterSess.body || {})));

  const email = "acctsec-staff@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["AcctSec Staff", email, hash, "manager"]
  );
  const staffLogin = await login(email, STAFF_PW, "198.51.100.94");
  eq(staffLogin.statusCode, 200);
  const staffTok = cookieFrom(staffLogin);
  const staffSess = await sessionProbe(staffTok);
  eq(staffSess.body?.authenticated, true);
  eq(staffSess.body?.isMaster, false);
  eq(staffSess.body?.role, "manager");
});

await section("M3: happy path — new works, old fails, other session revoked, current kept", async () => {
  resetAll();
  const email = "acctsec-happy@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  const [ins] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Happy Staff", email, hash, "writer"]
  );
  const staffId = Number(ins.insertId);
  const tokA = await createAdminSession({
    staffId,
    isMaster: false,
    role: "writer",
    name: "Happy Staff",
  });
  const tokB = await createAdminSession({
    staffId,
    isMaster: false,
    role: "writer",
    name: "Happy Staff",
  });
  eq((await sessionProbe(tokA)).body?.authenticated, true);
  eq((await sessionProbe(tokB)).body?.authenticated, true);

  const r = await changePassword(tokA, {
    currentPassword: STAFF_PW,
    newPassword: STAFF_PW_NEW,
  });
  eq(r.statusCode, 200, JSON.stringify(r.body));
  eq(r.body?.success, true);
  ok(typeof r.body?.sessionsRevoked === "number");
  ok(r.body.sessionsRevoked >= 1);

  const audit = await latestAudit();
  eq(audit.action, "update");
  eq(String(audit.entity_type), "admin_staff");
  const detail = JSON.parse(String(audit.detail_json || "{}"));
  eq(detail.selfPasswordChange, true);
  ok(typeof detail.sessionsRevoked === "number");
  assertNoPwLeak(audit, "happy path audit");

  eq((await sessionProbe(tokA)).body?.authenticated, true, "current kept");
  eq((await sessionProbe(tokB)).body?.authenticated, false, "other revoked");

  const oldLogin = await login(email, STAFF_PW, "198.51.100.95");
  eq(oldLogin.statusCode, 401, "old password fails");
  const newLogin = await login(email, STAFF_PW_NEW, "198.51.100.96");
  eq(newLogin.statusCode, 200, "new password works");
});

await section("M3: wrong current → 401; 5 wrong → 429", async () => {
  resetAll();
  const email = "acctsec-lock@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  const [ins] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Lock Staff", email, hash, "manager"]
  );
  const staffId = Number(ins.insertId);
  const tok = await createAdminSession({
    staffId,
    isMaster: false,
    role: "manager",
    name: "Lock Staff",
  });
  const ip = "198.51.100.97";
  const t0 = 1_900_000_000_000;
  setAdminLoginGuardClockForTests(t0);

  for (let i = 0; i < 5; i++) {
    setAdminLoginGuardClockForTests(t0 + i * 1000);
    const r = await changePassword(
      tok,
      { currentPassword: WRONG_PW, newPassword: STAFF_PW_NEW },
      { ip }
    );
    eq(r.statusCode, 401, `wrong ${i}`);
  }
  clearLimiters();
  setAdminLoginGuardClockForTests(t0 + 10_000);
  const locked = await changePassword(
    tok,
    { currentPassword: STAFF_PW, newPassword: STAFF_PW_NEW },
    { ip }
  );
  eq(locked.statusCode, 429);
  eq(locked.body?.error, ADMIN_LOGIN_LOCK_BODY.error);
});

await section("M3: too short → 400; same as current → 400", async () => {
  resetAll();
  const email = "acctsec-val@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  const [ins] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Val Staff", email, hash, "writer"]
  );
  const staffId = Number(ins.insertId);
  const tok = await createAdminSession({
    staffId,
    isMaster: false,
    role: "writer",
    name: "Val Staff",
  });

  let r = await changePassword(tok, {
    currentPassword: STAFF_PW,
    newPassword: SHORT_PW,
  });
  eq(r.statusCode, 400);
  ok(String(r.body?.error || "").length > 0);

  r = await changePassword(tok, {
    currentPassword: STAFF_PW,
    newPassword: STAFF_PW,
  });
  eq(r.statusCode, 400);
  ok(String(r.body?.error || "").toLowerCase().includes("different"));
});

await section("M3: master → 403; unauthenticated → 401; cross-origin → rejected", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD = MASTER_PW;
  const masterTok = await createAdminSession({
    staffId: null,
    isMaster: true,
    role: "super_admin",
    name: "Admin",
  });
  let r = await changePassword(masterTok, {
    currentPassword: MASTER_PW,
    newPassword: STAFF_PW_NEW,
  });
  eq(r.statusCode, 403);
  eq(r.body?.error, MASTER_PASSWORD_HOSTING_MESSAGE);

  r = await invoke(changeHandler, {
    method: "POST",
    url: "/api/admin-change-password",
    body: { currentPassword: STAFF_PW, newPassword: STAFF_PW_NEW },
    headers: { origin: "http://orders.test" },
  });
  eq(r.statusCode, 401);

  const email = "acctsec-cors@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  const [ins] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Cors Staff", email, hash, "writer"]
  );
  const staffId = Number(ins.insertId);
  const tok = await createAdminSession({
    staffId,
    isMaster: false,
    role: "writer",
    name: "Cors Staff",
  });
  r = await invoke(changeHandler, {
    method: "POST",
    url: "/api/admin-change-password",
    body: { currentPassword: STAFF_PW, newPassword: STAFF_PW_NEW },
    cookies: { sAdminSession: tok },
    headers: { origin: "https://evil.example" },
  });
  eq(r.statusCode, 403);
});

await section("F54: master session ends when master env cleared; staff unaffected", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD = MASTER_PW;

  const masterLogin = await login("admin", MASTER_PW, "198.51.100.110");
  eq(masterLogin.statusCode, 200, JSON.stringify(masterLogin.body));
  const masterTok = cookieFrom(masterLogin);
  ok(masterTok, "master cookie");

  let staffGet = await invoke(staffHandler, {
    method: "GET",
    url: "/api/admin-staff",
    ...adminReq(masterTok),
  });
  eq(staffGet.statusCode, 200, "protected route with master env");
  let sess = await sessionProbe(masterTok);
  eq(sess.statusCode, 200);
  eq(sess.body?.authenticated, true);

  const email = "acctsec-f54-staff@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  const [ins] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["F54 Staff", email, hash, "manager"]
  );
  const staffId = Number(ins.insertId);
  const staffTok = await createAdminSession({
    staffId,
    isMaster: false,
    role: "manager",
    name: "F54 Staff",
  });

  const [beforeAudit] = await pool.query(
    `SELECT COUNT(*) AS c FROM admin_audit_log
     WHERE action = 'logout' AND detail_json LIKE '%master_disabled%'`
  );
  const beforeCount = Number((Array.isArray(beforeAudit) ? beforeAudit[0] : beforeAudit)?.c || 0);

  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD_SHA256;
  delete process.env.ADMIN_PASSWORD_HASH;

  staffGet = await invoke(staffHandler, {
    method: "GET",
    url: "/api/admin-staff",
    ...adminReq(masterTok),
  });
  eq(staffGet.statusCode, 401, "same master cookie rejected without master env");

  sess = await sessionProbe(masterTok);
  eq(sess.statusCode, 200);
  eq(sess.body?.authenticated, false);

  const masterHash = hashSessionToken(masterTok);
  const [sessRows] = await pool.query(
    "SELECT id FROM admin_sessions WHERE token_hash = ? LIMIT 1",
    [masterHash]
  );
  eq(Array.isArray(sessRows) ? sessRows.length : 0, 0, "master session row deleted");

  const [afterAudit] = await pool.query(
    `SELECT COUNT(*) AS c FROM admin_audit_log
     WHERE action = 'logout' AND detail_json LIKE '%master_disabled%'`
  );
  const afterCount = Number((Array.isArray(afterAudit) ? afterAudit[0] : afterAudit)?.c || 0);
  eq(afterCount, beforeCount + 1, "exactly one master_disabled logout audit");

  const staffGet2 = await invoke(staffHandler, {
    method: "GET",
    url: "/api/admin-staff",
    ...adminReq(staffTok),
  });
  // manager lacks staff:view → 403 means session still authenticated
  eq(staffGet2.statusCode, 403, "staff session still resolves without master env");
  eq((await sessionProbe(staffTok)).body?.authenticated, true);

  process.env.ADMIN_PASSWORD = MASTER_PW;
  const again = await login("admin", MASTER_PW, "198.51.100.111");
  eq(again.statusCode, 200, "master login works again after env restored");
  ok(cookieFrom(again));
});

await section("M3: audit leak scan (no password values)", async () => {
  const [rows] = await pool.query(
    `SELECT id, action, summary, detail_json FROM admin_audit_log
     WHERE entity_type IN ('admin_session','admin_staff')
     ORDER BY id DESC LIMIT 200`
  );
  for (const row of Array.isArray(rows) ? rows : []) {
    assertNoPwLeak(row, `audit#${row.id}`);
  }
});

resetAll();
await pool.end();
console.log(
  `ADMIN_ACCOUNT_SECURITY_DB_PASS ${JSON.stringify({ sections: sections.length, assertions: total() })}`
);
