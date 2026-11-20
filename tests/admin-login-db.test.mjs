/**
 * SANDY-BATCH-27 — ADMIN-LOGIN-01 local DB/HTTP suite (in-process handlers).
 *
 * Schema: migrations/0001–0011 + tax. DB: sandy_mig_orders @ 127.0.0.1:3307.
 * Env: SANDY_TEST_DB_PASSWORD (required, never printed).
 * Master password fixtures are built at runtime and never written to evidence.
 *
 * Run: node tests/admin-login-db.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
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

/** Runtime-built — never a quoted secret_assignment literal in source. */
const MASTER_PW = ["Batch27", "Master", "Pw", crypto.randomBytes(4).toString("hex")].join("");
const STAFF_PW = ["Batch27", "Staff", "Pw", crypto.randomBytes(4).toString("hex")].join("");
const STAFF_PW2 = ["Batch27", "Staff2", "Pw", crypto.randomBytes(4).toString("hex")].join("");
const WRONG_PW = ["Batch27", "Wrong", "Pw", crypto.randomBytes(4).toString("hex")].join("");
const OTHER_STAFF_PW = ["Batch27", "Other", "Pw", crypto.randomBytes(4).toString("hex")].join("");

await rebuildFromMigrations();
await applyDeliveryOpsMigration();
await runSqlOnTestDb(readFileSync(path.join(root, "migrations/0011-admin-audit-log.sql"), "utf8"));

const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const {
  resetAdminLoginGuardForTests,
  setAdminLoginGuardClockForTests,
  ADMIN_LOGIN_GUARD_LOCK_MS,
  ADMIN_LOGIN_LOCK_BODY,
} = await importFromRoot("lib/adminLoginGuard.ts");
const { resetAuditThrottleForTests } = await importFromRoot("lib/auditLog.ts");
const { hashAdminStaffPassword } = await importFromRoot("lib/adminStaffPassword.ts");
const { createAdminSession } = await importFromRoot("lib/adminAuth.ts");

const loginHandler = (await importFromRoot("pages/api/admin-login.ts")).default;
const logoutHandler = (await importFromRoot("pages/api/admin-logout.ts")).default;
const staffHandler = (await importFromRoot("pages/api/admin-staff.ts")).default;
const sessionHandler = (await importFromRoot("pages/api/admin-session.ts")).default;

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

async function login(username, password, ip = "198.51.100.40") {
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

function assertNoPwLeak(row, label) {
  const blob = JSON.stringify(row || {});
  for (const pw of [MASTER_PW, STAFF_PW, STAFF_PW2, WRONG_PW, OTHER_STAFF_PW]) {
    ok(!blob.includes(pw), `${label}: password value must not appear in audit`);
  }
}

async function latestAudit() {
  const [rows] = await pool.query("SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT 1");
  return Array.isArray(rows) ? rows[0] : null;
}

await section("master plaintext ADMIN_PASSWORD → 200", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD = MASTER_PW;
  const r = await login("admin", MASTER_PW);
  eq(r.statusCode, 200, JSON.stringify(r.body));
  ok(cookieFrom(r), "session cookie");
  const row = await latestAudit();
  eq(row.action, "login_success");
  assertNoPwLeak(row, "master plaintext success");
});

await section("master ADMIN_PASSWORD_SHA256 → 200", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD_SHA256 = crypto
    .createHash("sha256")
    .update(MASTER_PW)
    .digest("hex");
  const r = await login("admin", MASTER_PW, "198.51.100.41");
  eq(r.statusCode, 200, JSON.stringify(r.body));
  assertNoPwLeak(await latestAudit(), "sha256 success");
});

await section("master ADMIN_PASSWORD_HASH bcrypt → 200", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD_HASH = await bcrypt.hash(MASTER_PW, 12);
  const r = await login("admin", MASTER_PW, "198.51.100.42");
  eq(r.statusCode, 200, JSON.stringify(r.body));
  assertNoPwLeak(await latestAudit(), "bcrypt success");
});

await section("wrong master password → 401", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD = MASTER_PW;
  const r = await login("admin", WRONG_PW, "198.51.100.43");
  eq(r.statusCode, 401);
  const row = await latestAudit();
  eq(row.action, "login_failed");
  assertNoPwLeak(row, "wrong master");
});

await section("key A lockout: 5 wrong → 429 even with correct; clock advance → 200", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD = MASTER_PW;
  const ip = "198.51.100.44";
  const t0 = 1_800_000_000_000;
  setAdminLoginGuardClockForTests(t0);

  for (let i = 0; i < 5; i++) {
    setAdminLoginGuardClockForTests(t0 + i * 1000);
    const r = await login("admin", WRONG_PW, ip);
    eq(r.statusCode, 401, `fail ${i}`);
  }
  // Clear RL so the next attempt exercises the account guard, not RL_AUTH
  clearLimiters();
  setAdminLoginGuardClockForTests(t0 + 10_000);
  let r = await login("admin", MASTER_PW, ip);
  eq(r.statusCode, 429, "locked even with correct password");
  eq(r.body?.error, ADMIN_LOGIN_LOCK_BODY.error);
  const lockedRow = await latestAudit();
  eq(JSON.parse(String(lockedRow.detail_json || "{}")).reason, "locked");
  assertNoPwLeak(lockedRow, "locked audit");

  setAdminLoginGuardClockForTests(t0 + 10_000 + ADMIN_LOGIN_GUARD_LOCK_MS);
  clearLimiters();
  r = await login("admin", MASTER_PW, ip);
  eq(r.statusCode, 200, `after window ${JSON.stringify(r.body)}`);
});

await section("staff wrong password → 401 without master path (no fall-through)", async () => {
  resetAll();
  process.env.ADMIN_PASSWORD = MASTER_PW;
  const email = "login01-staff@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Login01 Staff", email, hash, "manager"]
  );
  // Even if master password is submitted for a staff email, L3 must 401 (staff row matched)
  const r = await login(email, MASTER_PW, "198.51.100.45");
  eq(r.statusCode, 401);
  const row = await latestAudit();
  eq(row.action, "login_failed");
  eq(JSON.parse(String(row.detail_json || "{}")).reason, "wrong_password");
  assertNoPwLeak(row, "staff no fall-through");
});

await section("staff password change revokes other session; caller stays valid", async () => {
  resetAll();
  const email = "login01-self@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  const [ins] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Self SA", email, hash, "super_admin"]
  );
  const staffId = Number(ins.insertId);

  const tokA = await createAdminSession({
    staffId,
    isMaster: false,
    role: "super_admin",
    name: "Self SA",
  });
  const tokB = await createAdminSession({
    staffId,
    isMaster: false,
    role: "super_admin",
    name: "Self SA",
  });

  eq((await sessionProbe(tokA)).body?.authenticated, true);
  eq((await sessionProbe(tokB)).body?.authenticated, true);

  // Caller uses tokA to change own password
  clearLimiters();
  const put = await invoke(staffHandler, {
    method: "PUT",
    url: "/api/admin-staff",
    body: {
      id: staffId,
      name: "Self SA",
      email,
      role: "super_admin",
      password: STAFF_PW2,
      active: 1,
    },
    ...adminReq(tokA),
  });
  eq(put.statusCode, 200, JSON.stringify(put.body));

  eq((await sessionProbe(tokA)).body?.authenticated, true, "caller session kept");
  eq((await sessionProbe(tokB)).body?.authenticated, false, "other session revoked");

  const audit = await latestAudit();
  const detail = JSON.parse(String(audit.detail_json || "{}"));
  ok(typeof detail.sessionsRevoked === "number", "sessionsRevoked count");
  ok(detail.sessionsRevoked >= 1, "at least one other session revoked");
  assertNoPwLeak(audit, "password change audit");
});

await section("deactivate staff → all sessions gone", async () => {
  resetAll();
  const email = "login01-deact@example.test";
  const hash = await hashAdminStaffPassword(OTHER_STAFF_PW);
  const [ins] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Deact Target", email, hash, "writer"]
  );
  const staffId = Number(ins.insertId);
  const tok = await createAdminSession({
    staffId,
    isMaster: false,
    role: "writer",
    name: "Deact Target",
  });
  eq((await sessionProbe(tok)).body?.authenticated, true);

  const masterTok = await createAdminSession({
    staffId: null,
    isMaster: true,
    role: "super_admin",
    name: "Admin",
  });
  clearLimiters();
  const put = await invoke(staffHandler, {
    method: "PUT",
    url: "/api/admin-staff",
    body: {
      id: staffId,
      name: "Deact Target",
      email,
      role: "writer",
      active: 0,
    },
    ...adminReq(masterTok),
  });
  eq(put.statusCode, 200, JSON.stringify(put.body));
  eq((await sessionProbe(tok)).body?.authenticated, false);
  const audit = await latestAudit();
  const detail = JSON.parse(String(audit.detail_json || "{}"));
  ok(detail.sessionsRevoked >= 1);
  assertNoPwLeak(audit, "deactivate audit");
});

await section("logout-all for staff and master", async () => {
  resetAll();
  const email = "login01-logoutall@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  const [ins] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Logout All", email, hash, "manager"]
  );
  const staffId = Number(ins.insertId);
  const s1 = await createAdminSession({
    staffId,
    isMaster: false,
    role: "manager",
    name: "Logout All",
  });
  const s2 = await createAdminSession({
    staffId,
    isMaster: false,
    role: "manager",
    name: "Logout All",
  });

  clearLimiters();
  let r = await invoke(logoutHandler, {
    method: "POST",
    url: "/api/admin-logout",
    body: { scope: "all" },
    ...adminReq(s1),
  });
  eq(r.statusCode, 200);
  ok(r.body?.sessionsRevoked >= 2);
  eq((await sessionProbe(s1)).body?.authenticated, false);
  eq((await sessionProbe(s2)).body?.authenticated, false);
  let audit = await latestAudit();
  let detail = JSON.parse(String(audit.detail_json || "{}"));
  eq(detail.scope, "all");
  ok(typeof detail.sessionsRevoked === "number");
  assertNoPwLeak(audit, "staff logout-all");

  const m1 = await createAdminSession({
    staffId: null,
    isMaster: true,
    role: "super_admin",
    name: "Admin",
  });
  const m2 = await createAdminSession({
    staffId: null,
    isMaster: true,
    role: "super_admin",
    name: "Admin",
  });
  clearLimiters();
  r = await invoke(logoutHandler, {
    method: "POST",
    url: "/api/admin-logout",
    body: { scope: "all" },
    ...adminReq(m1),
  });
  eq(r.statusCode, 200);
  ok(r.body?.sessionsRevoked >= 2);
  eq((await sessionProbe(m1)).body?.authenticated, false);
  eq((await sessionProbe(m2)).body?.authenticated, false);
  audit = await latestAudit();
  detail = JSON.parse(String(audit.detail_json || "{}"));
  eq(detail.scope, "all");
  assertNoPwLeak(audit, "master logout-all");

  // Plain POST (no scope) still works for a fresh session
  const m3 = await createAdminSession({
    staffId: null,
    isMaster: true,
    role: "super_admin",
    name: "Admin",
  });
  clearLimiters();
  r = await invoke(logoutHandler, {
    method: "POST",
    url: "/api/admin-logout",
    body: {},
    ...adminReq(m3),
  });
  eq(r.statusCode, 200);
  eq((await sessionProbe(m3)).body?.authenticated, false);
});

await section("self demote/deactivate/delete → 409; last active super_admin → 409", async () => {
  resetAll();
  // Isolate: deactivate any leftover SA staff from earlier sections
  await pool.query(
    "UPDATE admin_staff SET active=0 WHERE role='super_admin' AND email LIKE 'login01-%'"
  );

  // Ensure at least one other SA so we can test self-guards without last-SA blocking first
  const otherHash = await hashAdminStaffPassword(OTHER_STAFF_PW);
  const [otherIns] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Other SA", "login01-other-sa@example.test", otherHash, "super_admin"]
  );
  const otherId = Number(otherIns.insertId);

  const email = "login01-selfguard@example.test";
  const hash = await hashAdminStaffPassword(STAFF_PW);
  const [ins] = await pool.query(
    "INSERT INTO admin_staff (name,email,password_hash,role,active) VALUES (?,?,?,?,1)",
    ["Self Guard", email, hash, "super_admin"]
  );
  const staffId = Number(ins.insertId);
  const tok = await createAdminSession({
    staffId,
    isMaster: false,
    role: "super_admin",
    name: "Self Guard",
  });

  clearLimiters();
  let r = await invoke(staffHandler, {
    method: "PUT",
    url: "/api/admin-staff",
    body: { id: staffId, name: "Self Guard", email, role: "manager", active: 1 },
    ...adminReq(tok),
  });
  eq(r.statusCode, 409, "self demote");
  ok(String(r.body?.error || "").length > 0);

  clearLimiters();
  r = await invoke(staffHandler, {
    method: "PUT",
    url: "/api/admin-staff",
    body: { id: staffId, name: "Self Guard", email, role: "super_admin", active: 0 },
    ...adminReq(tok),
  });
  eq(r.statusCode, 409, "self deactivate");

  clearLimiters();
  r = await invoke(staffHandler, {
    method: "DELETE",
    url: `/api/admin-staff?id=${staffId}`,
    query: { id: String(staffId) },
    ...adminReq(tok),
  });
  eq(r.statusCode, 409, "self delete");

  // Master can deactivate one SA while another remains
  const masterTok = await createAdminSession({
    staffId: null,
    isMaster: true,
    role: "super_admin",
    name: "Admin",
  });
  clearLimiters();
  r = await invoke(staffHandler, {
    method: "PUT",
    url: "/api/admin-staff",
    body: {
      id: staffId,
      name: "Self Guard",
      email,
      role: "super_admin",
      active: 0,
    },
    ...adminReq(masterTok),
  });
  eq(r.statusCode, 200, "master deactivate non-self SA ok");

  // Last remaining active SA cannot be removed
  clearLimiters();
  r = await invoke(staffHandler, {
    method: "PUT",
    url: "/api/admin-staff",
    body: {
      id: otherId,
      name: "Other SA",
      email: "login01-other-sa@example.test",
      role: "manager",
      active: 1,
    },
    ...adminReq(masterTok),
  });
  eq(r.statusCode, 409, "last SA demote");
  ok(String(r.body?.error || "").toLowerCase().includes("super_admin"));

  clearLimiters();
  r = await invoke(staffHandler, {
    method: "DELETE",
    url: `/api/admin-staff?id=${otherId}`,
    query: { id: String(otherId) },
    ...adminReq(masterTok),
  });
  eq(r.statusCode, 409, "last SA delete");
});

await section("audit leak scan across login01 rows", async () => {
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
  `ADMIN_LOGIN_DB_PASS ${JSON.stringify({ sections: sections.length, assertions: total() })}`
);
