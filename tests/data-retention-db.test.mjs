/**
 * HARDEN-01 — data retention purge against local MariaDB (127.0.0.1:3307).
 * Env: SANDY_TEST_DB_PASSWORD. Run: node tests/data-retention-db.test.mjs
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
} from "./orders-test-support.mjs";

requirePassword();
installTsResolveHook();
process.env.NODE_ENV = "test";

const MASTER_PW = ["Batch38", "Master", "Pw", crypto.randomBytes(4).toString("hex")].join("");

await rebuildFromMigrations();
await applyDeliveryOpsMigration();
await runSqlOnTestDb(readFileSync(path.join(root, "migrations/0011-admin-audit-log.sql"), "utf8"));

const pool = createPool();
globalThis._mysqlPool = pool;

const { __rateLimitTestUtils } = await importFromRoot("lib/rateLimit.ts");
const {
  maybePurgeStaleRows,
  resetDataRetentionThrottleForTests,
} = await importFromRoot("lib/dataRetention.ts");
const { resetAuditSchemaProbeForTests, resetAuditThrottleForTests } =
  await importFromRoot("lib/auditLog.ts");
const {
  resetOrderIdStateForTests,
  setOrderIdClockForTests,
} = await importFromRoot("lib/orderId.ts");
const loginHandler = (await importFromRoot("pages/api/admin-login.ts")).default;
const ordersHandler = (await importFromRoot("pages/api/orders.ts")).default;

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

async function one(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) ? rows[0] : undefined;
}
async function count(sql, params = []) {
  return Number((await one(sql, params))?.c || 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failure = null;
try {
  await section("purge deletes only rows older than 30 days (DB clock)", async () => {
    resetDataRetentionThrottleForTests();
    resetAuditSchemaProbeForTests();
    await pool.query("DELETE FROM order_checkout_attempts");
    await pool.query("DELETE FROM otp_challenges");
    await pool.query("DELETE FROM admin_audit_log WHERE action = 'data_purge'");

    await pool.query(
      `INSERT INTO order_checkout_attempts (idempotency_key, request_fingerprint, order_id, created_at)
       VALUES ('old-key', REPEAT('a',64), NULL, NOW() - INTERVAL 40 DAY)`
    );
    await pool.query(
      `INSERT INTO order_checkout_attempts (idempotency_key, request_fingerprint, order_id, created_at)
       VALUES ('fresh-key', REPEAT('b',64), NULL, NOW() - INTERVAL 1 DAY)`
    );
    await pool.query(
      `INSERT INTO otp_challenges
         (id, phone_norm, purpose, provider, status, attempts, expires_at, created_at)
       VALUES
         (?, '03001110001', 'cod_checkout', 'mock', 'sent', 0, NOW() + INTERVAL 1 HOUR, NOW() - INTERVAL 40 DAY),
         (?, '03001110002', 'cod_checkout', 'mock', 'sent', 0, NOW() + INTERVAL 1 HOUR, NOW() - INTERVAL 1 DAY)`,
      [crypto.randomUUID(), crypto.randomUUID()]
    );

    eq(await count("SELECT COUNT(*) AS c FROM order_checkout_attempts"), 2);
    eq(await count("SELECT COUNT(*) AS c FROM otp_challenges"), 2);

    await maybePurgeStaleRows(pool, Date.now());

    eq(await count("SELECT COUNT(*) AS c FROM order_checkout_attempts"), 1, "fresh attempt kept");
    eq(await count("SELECT COUNT(*) AS c FROM otp_challenges"), 1, "fresh otp kept");
    eq(
      await count(
        "SELECT COUNT(*) AS c FROM order_checkout_attempts WHERE idempotency_key = 'fresh-key'"
      ),
      1
    );

    const audit = await one(
      "SELECT action, entity_type, entity_id, detail_json FROM admin_audit_log WHERE action = 'data_purge' ORDER BY id DESC LIMIT 1"
    );
    ok(audit, "data_purge audit row");
    eq(audit.entity_type, "retention");
    eq(audit.entity_id, null);
    const detail = JSON.parse(audit.detail_json);
    eq(detail.checkout_attempts, 1);
    eq(detail.otp_challenges, 1);
    eq(detail.audit_log, 0);
    eq(
      Object.keys(detail).sort().join(","),
      "audit_log,checkout_attempts,otp_challenges"
    );
  });

  await section("D62: audit_log rows older than 365 days purged; newer kept", async () => {
    resetDataRetentionThrottleForTests();
    resetAuditSchemaProbeForTests();
    await pool.query("DELETE FROM order_checkout_attempts");
    await pool.query("DELETE FROM otp_challenges");
    await pool.query("DELETE FROM admin_audit_log");

    await pool.query(
      `INSERT INTO admin_audit_log
        (actor_type, actor_staff_id, actor_name, actor_role, action, entity_type, entity_id,
         summary, detail_json, created_at)
       VALUES
         ('system', NULL, 'old', NULL, 'update', 'product', '1', 'old row', NULL, NOW() - INTERVAL 400 DAY),
         ('system', NULL, 'fresh', NULL, 'update', 'product', '2', 'fresh row', NULL, NOW() - INTERVAL 10 DAY)`
    );
    eq(await count("SELECT COUNT(*) AS c FROM admin_audit_log"), 2);

    await maybePurgeStaleRows(pool, Date.now());

    eq(
      await count("SELECT COUNT(*) AS c FROM admin_audit_log WHERE summary = 'old row'"),
      0,
      "old audit row purged"
    );
    eq(
      await count("SELECT COUNT(*) AS c FROM admin_audit_log WHERE summary = 'fresh row'"),
      1,
      "fresh audit row kept"
    );
    const purge = await one(
      "SELECT detail_json FROM admin_audit_log WHERE action = 'data_purge' ORDER BY id DESC LIMIT 1"
    );
    ok(purge, "data_purge written when audit_log deleted");
    const d = JSON.parse(purge.detail_json);
    eq(d.audit_log, 1);
    eq(d.checkout_attempts, 0);
    eq(d.otp_challenges, 0);
  });

  await section("D62: no data_purge row when nothing deleted (incl. audit)", async () => {
    resetDataRetentionThrottleForTests();
    resetAuditSchemaProbeForTests();
    await pool.query("DELETE FROM order_checkout_attempts");
    await pool.query("DELETE FROM otp_challenges");
    await pool.query("DELETE FROM admin_audit_log");
    await pool.query(
      `INSERT INTO admin_audit_log
        (actor_type, actor_staff_id, actor_name, actor_role, action, entity_type, entity_id,
         summary, detail_json, created_at)
       VALUES ('system', NULL, 'fresh2', NULL, 'update', 'product', '3', 'keep', NULL, NOW() - INTERVAL 1 DAY)`
    );
    await maybePurgeStaleRows(pool, Date.now());
    eq(
      await count("SELECT COUNT(*) AS c FROM admin_audit_log WHERE action = 'data_purge'"),
      0,
      "no data_purge when nothing deleted"
    );
    eq(await count("SELECT COUNT(*) AS c FROM admin_audit_log"), 1);
  });

  await section("second purge within throttle does nothing", async () => {
    const auditsBefore = await count(
      "SELECT COUNT(*) AS c FROM admin_audit_log WHERE action = 'data_purge'"
    );
    const attemptsBefore = await count("SELECT COUNT(*) AS c FROM order_checkout_attempts");
    await maybePurgeStaleRows(pool, Date.now() + 1000);
    eq(await count("SELECT COUNT(*) AS c FROM order_checkout_attempts"), attemptsBefore);
    eq(
      await count("SELECT COUNT(*) AS c FROM admin_audit_log WHERE action = 'data_purge'"),
      auditsBefore
    );
  });

  await section("admin-login success 200 body shape unchanged + purge triggered", async () => {
    resetDataRetentionThrottleForTests();
    clearLimiters();
    process.env.ADMIN_PASSWORD = MASTER_PW;
    delete process.env.ADMIN_PASSWORD_SHA256;
    delete process.env.ADMIN_PASSWORD_HASH;

    // Seed another old row so fire-and-forget purge has work
    await pool.query(
      `INSERT INTO order_checkout_attempts (idempotency_key, request_fingerprint, order_id, created_at)
       VALUES ('old-key-login', REPEAT('c',64), NULL, NOW() - INTERVAL 40 DAY)
       ON DUPLICATE KEY UPDATE created_at = NOW() - INTERVAL 40 DAY`
    );

    const res = await invoke(loginHandler, {
      method: "POST",
      url: "/api/admin-login",
      body: { username: "admin", password: MASTER_PW },
      headers: { origin: "http://orders.test" },
      ip: "198.51.100.88",
    });
    eq(res.statusCode, 200, JSON.stringify(res.body));
    eq(res.body.success, true);
    eq(res.body.role, "super_admin");
    eq(res.body.name, "Admin");
    ok(!("staffUser" in res.body));

    // Allow void maybePurgeStaleRows to finish
    for (let i = 0; i < 40; i++) {
      const n = await count(
        "SELECT COUNT(*) AS c FROM order_checkout_attempts WHERE idempotency_key = 'old-key-login'"
      );
      if (n === 0) break;
      await sleep(50);
    }
    eq(
      await count(
        "SELECT COUNT(*) AS c FROM order_checkout_attempts WHERE idempotency_key = 'old-key-login'"
      ),
      0,
      "login-triggered purge removed old row"
    );
  });

  await section("H3: duplicate order_id regenerates; idempotency replay intact", async () => {
    clearLimiters();
    resetOrderIdStateForTests();
    await pool.query(
      `INSERT INTO products (name, slug, price, category, stock, track_inventory, stock_quantity, active)
       VALUES ('Retention Case', 'retention-case', 500, 'Accessories', '20', 1, 20, 1)`
    );
    const product = await one("SELECT id FROM products WHERE slug = 'retention-case'");

    const FIXED = 1_800_000_000_000;
    // Occupy ORD-FIXED so first nextOrderId collides
    await pool.query(
      `INSERT INTO orders (order_id, customer_name, customer_email, customer_phone, delivery_address, city, postcode, notes, payment_method, total, status)
       VALUES (?, 'Pre', 'pre@example.test', '03330000001', 'Addr', 'Lahore', '54000', '', 'cod', 500, 'pending')`,
      [`ORD-${FIXED}`]
    );

    setOrderIdClockForTests(() => FIXED);
    resetOrderIdStateForTests();

    const key = crypto.randomUUID();
    const body = {
      customer_name: "Collision Customer",
      customer_email: "collision@example.test",
      customer_phone: "03331234567",
      delivery_address: "House 1",
      city: "Lahore",
      postcode: "54000",
      notes: "",
      payment_method: "cod",
      items: [{ id: product.id, qty: 1 }],
      idempotency_key: key,
    };

    __rateLimitTestUtils.clearStore();
    const res1 = await invoke(ordersHandler, { url: "/api/orders", body });
    eq(res1.statusCode, 200, JSON.stringify(res1.body));
    const id1 = res1.body.order_id;
    ok(id1 !== `ORD-${FIXED}`, `got distinct id ${id1}`);
    ok(String(id1).startsWith("ORD-"));

    __rateLimitTestUtils.clearStore();
    const res2 = await invoke(ordersHandler, { url: "/api/orders", body });
    eq(res2.statusCode, 200, JSON.stringify(res2.body));
    eq(res2.body.order_id, id1, "idempotency replay returns original");

    eq(
      await count("SELECT COUNT(*) AS c FROM orders WHERE order_id IN (?, ?)", [
        `ORD-${FIXED}`,
        id1,
      ]),
      2,
      "both pre-seeded and new orders exist"
    );

    setOrderIdClockForTests(null);
    resetOrderIdStateForTests();
  });

  console.log(`PASS ${sections.length} sections; assertions=${total()}`);
} catch (e) {
  failure = e;
  console.error("FAIL", e);
  process.exitCode = 1;
} finally {
  setOrderIdClockForTests(null);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
}
if (failure) throw failure;
