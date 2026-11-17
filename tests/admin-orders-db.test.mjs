/**
 * ADMIN-ORDERS-02 — local MariaDB integration test (127.0.0.1:3307 / sandy_test_local).
 *
 * Seeds 120 synthetic orders (order_id prefix `AO2-`) and checks the real SQL produced by
 * lib/adminOrdersQuery.ts (parseOrderListQuery + buildOrderWhere) against an independent
 * in-memory oracle. Only rows with order_id LIKE 'AO2-%' (and their order_items /
 * order_tax_snapshots) are ever deleted. Other rows in the DB (e.g. DASH-*) are untouched
 * and are excluded from every assertion by scoping queries to the seed prefix.
 *
 * Env: SANDY_TEST_DB_PASSWORD
 * Run: node tests/admin-orders-db.test.mjs
 *
 * The TS libs are loaded in-process through Node's built-in type stripping plus a tiny resolve
 * hook that maps extensionless relative imports (`./pktDateRange`) to `.ts`.
 */
import mysql from "mysql2/promise";
import assert from "node:assert/strict";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

if (!process.env.SANDY_TEST_DB_PASSWORD) {
  console.error("SANDY_TEST_DB_PASSWORD is required");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The repo's package.json has no "type"; Node warns once when it reparses lib/*.ts as ESM.
process.removeAllListeners("warning");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[mc]?[jt]sx?$/.test(specifier)
    ) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context);
  },
});

const Q = await import(pathToFileURL(path.join(root, "lib/adminOrdersQuery.ts")).href);
const P = await import(pathToFileURL(path.join(root, "lib/pktDateRange.ts")).href);
const {
  EXPORT_MAX,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  buildOrderWhere,
  csvEscapeCell,
  escapeLikeWildcards,
  itemsMetaForOrderIds,
  parseOrderListQuery,
  taxLabelsForOrderIds,
} = Q;
const { karachiMidnightUtcSql, resolvePktRange } = P;

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "sandy_test",
  password: process.env.SANDY_TEST_DB_PASSWORD,
  database: "sandy_test_local",
  charset: "utf8mb4",
  timezone: "Z",
  dateStrings: true,
});

const PREFIX = "AO2-";
const SCOPE = "o.order_id LIKE 'AO2-%'";

let assertions = 0;
const sections = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      sections.push(name);
    })
    .catch((e) => {
      e.message = `[${name}] ${e.message}`;
      throw e;
    });
}
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};
const ok = (v, m) => {
  assertions += 1;
  assert.ok(v, m);
};

/* ------------------------------------------------------------------ schema / cleanup */

async function ensureTables() {
  // Additive only (matches lib/ensureShopTables.ts). Never drops anything.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(50) NOT NULL,
      product_id INT,
      product_name VARCHAR(255),
      price DECIMAL(10,2),
      quantity INT DEFAULT 1
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_tax_snapshots (
      order_id VARCHAR(64) NOT NULL PRIMARY KEY,
      tax_label VARCHAR(64) NOT NULL,
      vat_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      snapshot_json LONGTEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function cleanup() {
  await pool.query("DELETE FROM order_items WHERE order_id LIKE 'AO2-%'");
  await pool.query("DELETE FROM order_tax_snapshots WHERE order_id LIKE 'AO2-%'");
  await pool.query("DELETE FROM orders WHERE order_id LIKE 'AO2-%'");
}

/* ------------------------------------------------------------------ seed model */

const pad = (n, w = 3) => String(n).padStart(w, "0");
/** PKT wall clock -> UTC SQL string (Karachi is fixed UTC+5). */
function utcFromPkt(y, m, d, hh, mm, ss) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - 5 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}
/** UTC SQL string -> PKT calendar day YYYY-MM-DD. */
function pktDay(utcSql) {
  return new Date(new Date(`${utcSql.replace(" ", "T")}Z`).getTime() + 5 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

const seed = [];
let seq = 0;
function add(o) {
  seq += 1;
  seed.push({
    seq,
    name: `Customer ${seq}`,
    email: `cust${pad(seq)}@ao2.test`,
    phone: `+92300${pad(seq, 6)}`,
    total: (100 + seq * 10.5).toFixed(2),
    vat: "15.00",
    discount: "0.00",
    snapshot: null,
    items: [],
    kind: "regular",
    ...o,
  });
}
const nextStatus = () => ORDER_STATUSES[seq % ORDER_STATUSES.length];
const nextPay = () => PAYMENT_METHODS[Math.floor(seq / 5) % PAYMENT_METHODS.length];

// 98 regular orders across PKT days 2026-03-10 .. 2026-03-15
for (let i = 1; i <= 98; i += 1) {
  const day = 10 + (i % 6);
  const created = utcFromPkt(2026, 3, day, 9 + (i % 10), (Math.floor(i / 6) * 3) % 60, 0);
  const total = (100 + i * 10.5).toFixed(2);
  const o = {
    order_id: `${PREFIX}R${pad(i)}`,
    status: ORDER_STATUSES[i % 5],
    pay: PAYMENT_METHODS[Math.floor(i / 5) % 4],
    created,
    total,
    discount: i % 10 === 0 ? "50.00" : "0.00",
    items: Array.from({ length: (i % 3) + 1 }, (_, k) => ({
      name: `Item ${i}-${k + 1}`,
      price: "100.00",
      qty: k + 1,
    })),
  };
  if (i % 3 === 0) {
    const vat = (Number(total) * 0.18).toFixed(2);
    const label = ["GST", "Sales Tax", "VAT"][(i / 3) % 3];
    o.vat = vat;
    o.snapshot = { label, vat, json: { label, lines: [{ name: label, rate: 18, amount: vat }] } };
  }
  add(o);
}
// 5 legacy rows: NULL vat_amount, NULL discount, NO snapshot (before main range, PKT 2026-03-09)
for (let i = 1; i <= 5; i += 1) {
  add({
    order_id: `${PREFIX}L${pad(i, 2)}`,
    kind: "legacy",
    status: nextStatus(),
    pay: nextPay(),
    created: utcFromPkt(2026, 3, 9, 10 + i, 0, 0),
    vat: null,
    discount: null,
    items: [{ name: `Legacy item ${i}`, price: "250.00", qty: 1 }],
  });
}
// 4 unicode names
const UNICODE_NAMES = ["Zoë Müller", "محمد علی", "李雷 Li Lei", "Ünïcode Ñame"];
UNICODE_NAMES.forEach((name, i) => {
  add({
    order_id: `${PREFIX}U${i + 1}`,
    kind: "unicode",
    name,
    email: `unicode${i + 1}@ao2.test`,
    status: nextStatus(),
    pay: nextPay(),
    created: utcFromPkt(2026, 3, 16, 9 + i, 0, 0),
  });
});
// 4 wildcard rows (3 contain % or _, 1 plain control)
const WILD = [
  { id: "W1", name: "50% Off Fan" },
  { id: "W2", name: "data_set Buyer" },
  { id: "W3", name: "Double%%Percent" },
  { id: "W4", name: "Fifty Percent Plain" },
];
WILD.forEach((w, i) => {
  add({
    order_id: `${PREFIX}${w.id}`,
    kind: "wildcard",
    name: w.name,
    status: nextStatus(),
    pay: nextPay(),
    created: utcFromPkt(2026, 3, 17, 9 + i, 0, 0),
  });
});
// 2 CSV-injection payload names
add({
  order_id: `${PREFIX}I1`,
  kind: "injection",
  name: "=cmd|' /C calc'!A0",
  email: "inject1@ao2.test",
  status: nextStatus(),
  pay: nextPay(),
  created: utcFromPkt(2026, 3, 18, 9, 0, 0),
});
add({
  order_id: `${PREFIX}I2`,
  kind: "injection",
  name: "+1 Plus Payload",
  email: "inject2@ao2.test",
  status: nextStatus(),
  pay: nextPay(),
  created: utcFromPkt(2026, 3, 18, 10, 0, 0),
});
// 4 PKT-midnight boundary rows
const BOUNDARY = [
  { id: "B1", created: "2026-03-11 18:59:59", pktDay: "2026-03-11" }, // PKT 23:59:59
  { id: "B2", created: "2026-03-11 19:00:00", pktDay: "2026-03-12" }, // PKT 00:00:00 exactly
  { id: "B3", created: "2026-03-11 19:00:01", pktDay: "2026-03-12" },
  { id: "B4", created: "2026-03-12 18:59:59", pktDay: "2026-03-12" }, // last second of PKT 03-12
];
for (const b of BOUNDARY) {
  add({
    order_id: `${PREFIX}${b.id}`,
    kind: "boundary",
    status: nextStatus(),
    pay: nextPay(),
    created: b.created,
  });
}
// 3 rows with an identical created_at (tie-break by id DESC)
for (let i = 1; i <= 3; i += 1) {
  add({
    order_id: `${PREFIX}T${i}`,
    kind: "tie",
    status: "pending",
    pay: "cod",
    created: "2026-03-13 06:00:00",
  });
}

eq(seed.length, 120, "seed must have exactly 120 orders");
eq(new Set(seed.map((s) => s.order_id)).size, 120, "unique order ids");
for (const s of seed) s.day = pktDay(s.created);

async function insertSeed() {
  const orderValues = seed.map((s) => [
    s.order_id,
    s.name,
    s.email,
    s.phone,
    s.total,
    s.vat,
    s.discount,
    s.status,
    s.pay,
    s.created,
  ]);
  await pool.query(
    `INSERT INTO orders
       (order_id, customer_name, customer_email, customer_phone, total, vat_amount,
        discount_amount, status, payment_method, created_at)
     VALUES ?`,
    [orderValues]
  );
  const itemValues = [];
  for (const s of seed) {
    for (const it of s.items) itemValues.push([s.order_id, null, it.name, it.price, it.qty]);
  }
  if (itemValues.length) {
    await pool.query(
      "INSERT INTO order_items (order_id, product_id, product_name, price, quantity) VALUES ?",
      [itemValues]
    );
  }
  const snapValues = seed
    .filter((s) => s.snapshot)
    .map((s) => [s.order_id, s.snapshot.label, s.snapshot.vat, JSON.stringify(s.snapshot.json)]);
  await pool.query(
    "INSERT INTO order_tax_snapshots (order_id, tax_label, vat_amount, snapshot_json) VALUES ?",
    [snapValues]
  );
  return { items: itemValues.length, snapshots: snapValues.length };
}

/* ------------------------------------------------------------------ oracle + SQL harness */

/** Newest first: created_at DESC, then insertion order (== auto-increment id) DESC. */
function oracleSorted(pred) {
  return seed
    .filter(pred)
    .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : b.seq - a.seq));
}

function oracleSearch(q) {
  const needle = q.toLowerCase();
  return (s) =>
    [s.order_id, s.name, s.email, s.phone].some((f) => String(f ?? "").toLowerCase().includes(needle));
}

function scoped(whereSql) {
  return whereSql ? `${whereSql} AND ${SCOPE}` : `WHERE ${SCOPE}`;
}

/** Mirrors pages/api/admin-orders.ts handleList (ID-first pagination) scoped to AO2-%. */
async function listQuery(query) {
  const parsed = parseOrderListQuery(query);
  assert.equal(parsed.ok, true, `parse failed for ${JSON.stringify(query)}`);
  const { filters, page, pageSize } = parsed;
  const { sql, params } = buildOrderWhere(filters, "o");
  const where = scoped(sql);
  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM orders o ${where}`, params);
  const total = Number(countRows[0].total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const [idRows] = await pool.query(
    `SELECT o.order_id FROM orders o ${where}
     ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [statusRows] = await pool.query(
    `SELECT status, COUNT(*) AS c FROM orders o ${where} GROUP BY status`,
    params
  );
  const status_counts = { pending: 0, confirmed: 0, dispatched: 0, delivered: 0, cancelled: 0 };
  for (const r of statusRows) status_counts[r.status] = Number(r.c);
  return {
    parsed,
    where,
    params,
    total,
    totalPages,
    page: safePage,
    pageSize,
    ids: idRows.map((r) => r.order_id),
    status_counts,
  };
}

/** Mirrors pages/api/admin-orders-export.ts id query (LIMIT = min(total, EXPORT_MAX)). */
async function exportIds(query, limitOverride) {
  const parsed = parseOrderListQuery(query);
  assert.equal(parsed.ok, true);
  const { sql, params } = buildOrderWhere(parsed.filters, "o");
  const where = scoped(sql);
  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM orders o ${where}`, params);
  const total = Number(countRows[0].total);
  const fetchLimit = limitOverride ?? Math.min(total, EXPORT_MAX);
  const [idRows] = await pool.query(
    `SELECT o.order_id FROM orders o ${where}
     ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
    [...params, fetchLimit]
  );
  return { total, ids: idRows.map((r) => r.order_id), truncated: total > EXPORT_MAX };
}

async function allPages(query, pageSize) {
  const first = await listQuery({ ...query, page: 1, pageSize });
  const ids = [...first.ids];
  for (let p = 2; p <= first.totalPages; p += 1) {
    const r = await listQuery({ ...query, page: p, pageSize });
    ids.push(...r.ids);
  }
  return { first, ids };
}

const idsOf = (rows) => rows.map((r) => r.order_id);

/* ------------------------------------------------------------------ tests */

async function main() {
  await ensureTables();
  await cleanup();
  const seeded = await insertSeed();

  // Auto-increment ids follow insertion order (needed for the id DESC tie-break oracle).
  const [idCheck] = await pool.query(
    "SELECT order_id, id FROM orders WHERE order_id LIKE 'AO2-%' ORDER BY id ASC"
  );
  eq(idsOf(idCheck), seed.map((s) => s.order_id), "ids ascend in insertion order");

  await check("karachiMidnightUtcSql + resolvePktRange", async () => {
    eq(karachiMidnightUtcSql(2026, 3, 12), "2026-03-11 19:00:00");
    eq(karachiMidnightUtcSql(2026, 1, 1), "2025-12-31 19:00:00");
    eq(karachiMidnightUtcSql(2026, 3, 1), "2026-02-28 19:00:00");
    const r = resolvePktRange({ preset: "custom", from: "2026-03-12", to: "2026-03-12" });
    ok(r.ok);
    eq(r.fromSql, "2026-03-11 19:00:00");
    eq(r.toExclusiveSql, "2026-03-12 19:00:00");
    eq(r.from, "2026-03-12");
    eq(r.to, "2026-03-12");
    eq(resolvePktRange({ preset: "custom", from: "2026-03-12", to: "2026-03-11" }).ok, false);
    eq(resolvePktRange({ preset: "custom", from: "nope", to: "2026-03-11" }).ok, false);
    eq(resolvePktRange({ preset: "nope" }).ok, false);
    eq(resolvePktRange({ preset: "all" }).fromSql, null);
  });

  await check("parseOrderListQuery validation", async () => {
    const bad = [
      { status: "bogus" },
      { pageSize: 7 },
      { pageSize: 0 },
      { q: "a" },
      { q: "x".repeat(81) },
      { payment_method: "cash" },
      { from: "2026-03-01" }, // from without to
      { from: "2026-03-05", to: "2026-03-01" },
      { from: "bad", to: "2026-03-01" },
      { preset: "decade" },
      { q: "%" }, // single char, below SEARCH_MIN
    ];
    for (const b of bad) eq(parseOrderListQuery(b).ok, false, `expected invalid ${JSON.stringify(b)}`);

    const good = parseOrderListQuery({ status: "PENDING", paymentMethod: "COD", limit: "10", page: "3" });
    ok(good.ok);
    eq(good.filters.status, "pending");
    eq(good.filters.paymentMethod, "cod");
    eq(good.pageSize, 10);
    eq(good.page, 3);
    // Documented clamp: pageSize > 100 clamps to 100 (an allowed size) instead of failing.
    const clamped = parseOrderListQuery({ pageSize: 1000 });
    ok(clamped.ok);
    eq(clamped.pageSize, 100);
    eq(parseOrderListQuery({ page: -5 }).page, 1);
    eq(parseOrderListQuery({ status: "all", payment_method: "all" }).filters.status, null);
    eq(parseOrderListQuery({}).pageSize, 25);
  });

  await check("seed integrity / distribution", async () => {
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE order_id LIKE 'AO2-%'");
    eq(Number(n), 120);
    const [st] = await pool.query(
      "SELECT status, COUNT(*) c FROM orders WHERE order_id LIKE 'AO2-%' GROUP BY status"
    );
    for (const s of ORDER_STATUSES) {
      const exp = seed.filter((x) => x.status === s).length;
      ok(exp > 0, `status ${s} present in seed`);
      eq(Number(st.find((r) => r.status === s)?.c || 0), exp, `status ${s} count`);
    }
    const [pm] = await pool.query(
      "SELECT payment_method, COUNT(*) c FROM orders WHERE order_id LIKE 'AO2-%' GROUP BY payment_method"
    );
    for (const p of PAYMENT_METHODS) {
      const exp = seed.filter((x) => x.pay === p).length;
      ok(exp > 0, `payment ${p} present in seed`);
      eq(Number(pm.find((r) => r.payment_method === p)?.c || 0), exp, `payment ${p} count`);
    }
    // (No JOIN: the stub orders table and order_tax_snapshots use different collations locally.)
    const [nullVat] = await pool.query(
      "SELECT order_id FROM orders WHERE order_id LIKE 'AO2-%' AND vat_amount IS NULL"
    );
    const [snapIds] = await pool.query("SELECT order_id FROM order_tax_snapshots WHERE order_id LIKE 'AO2-%'");
    const snapSet = new Set(snapIds.map((r) => r.order_id));
    const legacyIds = nullVat.map((r) => r.order_id).filter((id) => !snapSet.has(id));
    eq(legacyIds.length, 5, "5 legacy rows: NULL vat_amount and no snapshot");
    eq(nullVat.length, 5, "only legacy rows have NULL vat_amount");
    eq(seeded.snapshots, seed.filter((s) => s.snapshot).length);
    // Unicode / wildcard names survive the round trip byte-for-byte.
    const [u] = await pool.query(
      "SELECT order_id, customer_name FROM orders WHERE order_id LIKE 'AO2-U%' ORDER BY id"
    );
    eq(u.map((r) => r.customer_name), UNICODE_NAMES);
    const [w] = await pool.query(
      "SELECT customer_name FROM orders WHERE order_id LIKE 'AO2-W%' ORDER BY id"
    );
    eq(w.map((r) => r.customer_name), WILD.map((x) => x.name));
  });

  await check("pagination math (pageSize 10 and 25)", async () => {
    const fullOrder = oracleSorted(() => true).map((s) => s.order_id);

    for (const pageSize of [10, 25]) {
      const { first, ids } = await allPages({}, pageSize);
      eq(first.total, 120);
      eq(first.totalPages, Math.ceil(120 / pageSize));
      eq(ids.length, 120, `pageSize ${pageSize}: concatenated pages cover every row`);
      eq(new Set(ids).size, 120, `pageSize ${pageSize}: no duplicates across pages`);
      eq(ids, fullOrder, `pageSize ${pageSize}: pages concatenate to the oracle ordering`);
      const lastPage = await listQuery({ page: first.totalPages, pageSize });
      eq(lastPage.ids.length, 120 - (first.totalPages - 1) * pageSize, "last page size");
      // Page past the end clamps to the last page (as the API does).
      const beyond = await listQuery({ page: 9999, pageSize });
      eq(beyond.page, first.totalPages);
      eq(beyond.ids, lastPage.ids);
    }
    // Explicit shape numbers
    const p10 = await listQuery({ page: 1, pageSize: 10 });
    eq([p10.total, p10.totalPages, p10.ids.length], [120, 12, 10]);
    const p25 = await listQuery({ page: 5, pageSize: 25 });
    eq([p25.total, p25.totalPages, p25.ids.length], [120, 5, 20]);
    // An empty result still reports totalPages >= 1 (no page 0).
    const none = await listQuery({ q: "zzzz-no-such-order" });
    eq([none.total, none.totalPages, none.page, none.ids.length], [0, 1, 1, 0]);
    // status_counts always sum to total for the same filters.
    const sum = Object.values(p10.status_counts).reduce((a, b) => a + b, 0);
    eq(sum, p10.total);
  });

  await check("newest-first ordering (created_at DESC, id DESC)", async () => {
    const [rows] = await pool.query(
      `SELECT o.order_id, o.created_at, o.id FROM orders o WHERE ${SCOPE}
       ORDER BY o.created_at DESC, o.id DESC`
    );
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1];
      const b = rows[i];
      ok(
        a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id),
        `ordering violated at ${a.order_id} -> ${b.order_id}`
      );
    }
    const ids = rows.map((r) => r.order_id);
    ok(ids.indexOf("AO2-T3") === ids.indexOf("AO2-T2") - 1, "tie rows T3 before T2 (id DESC)");
    ok(ids.indexOf("AO2-T2") === ids.indexOf("AO2-T1") - 1, "tie rows T2 before T1 (id DESC)");
    eq(ids[0], "AO2-I2", "newest seeded order is first (PKT 03-18 10:00)");
  });

  await check("filters: status, payment, combined", async () => {
    for (const status of ORDER_STATUSES) {
      const exp = oracleSorted((s) => s.status === status);
      const r = await listQuery({ status, pageSize: 100 });
      eq(r.total, exp.length, `status=${status} total`);
      eq(r.ids, exp.map((s) => s.order_id), `status=${status} rows+order`);
      eq(r.status_counts[status], exp.length);
    }
    for (const payment_method of PAYMENT_METHODS) {
      const exp = oracleSorted((s) => s.pay === payment_method);
      const r = await listQuery({ payment_method, pageSize: 100 });
      eq(r.total, exp.length, `payment=${payment_method} total`);
      eq(r.ids, exp.map((s) => s.order_id), `payment=${payment_method} rows+order`);
    }
    for (const status of ORDER_STATUSES) {
      for (const payment_method of PAYMENT_METHODS) {
        const exp = oracleSorted((s) => s.status === status && s.pay === payment_method);
        const r = await listQuery({ status, payment_method, pageSize: 100 });
        eq(r.total, exp.length, `${status}+${payment_method} total`);
        eq(r.ids, exp.map((s) => s.order_id));
      }
    }
    // "all" sentinels behave as no filter
    const allAll = await listQuery({ status: "all", payment_method: "all", pageSize: 100 });
    eq(allAll.total, 120);
  });

  await check("filters: PKT date range incl. midnight boundary", async () => {
    const days = ["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-15", "2026-03-18"];
    for (const d of days) {
      const exp = oracleSorted((s) => s.day === d);
      const r = await listQuery({ from: d, to: d, pageSize: 100 });
      eq(r.total, exp.length, `single PKT day ${d} total`);
      eq(r.ids, exp.map((s) => s.order_id), `single PKT day ${d} rows`);
    }
    // Boundary rows land on the PKT day, not the UTC day.
    const d11 = (await listQuery({ from: "2026-03-11", to: "2026-03-11", pageSize: 100 })).ids;
    const d12 = (await listQuery({ from: "2026-03-12", to: "2026-03-12", pageSize: 100 })).ids;
    ok(d11.includes("AO2-B1") && !d12.includes("AO2-B1"), "B1 (PKT 23:59:59) belongs to 03-11");
    ok(!d11.includes("AO2-B2") && d12.includes("AO2-B2"), "B2 (PKT 00:00:00 exactly) belongs to 03-12");
    ok(d12.includes("AO2-B3"), "B3 (PKT 00:00:01) belongs to 03-12");
    ok(d12.includes("AO2-B4"), "B4 (PKT 03-12 23:59:59) belongs to 03-12");
    const d13 = (await listQuery({ from: "2026-03-13", to: "2026-03-13", pageSize: 100 })).ids;
    ok(!d13.includes("AO2-B4"), "B4 is not on 03-13");
    // Multi-day inclusive range
    const exp = oracleSorted((s) => s.day >= "2026-03-11" && s.day <= "2026-03-13");
    const r = await listQuery({ from: "2026-03-11", to: "2026-03-13", pageSize: 100 });
    eq(r.ids, exp.map((s) => s.order_id));
    // Range with no data
    eq((await listQuery({ from: "2026-02-01", to: "2026-02-02" })).total, 0);
    // preset=custom is equivalent to bare from/to
    const viaPreset = await listQuery({ preset: "custom", from: "2026-03-11", to: "2026-03-13", pageSize: 100 });
    eq(viaPreset.ids, r.ids);
  });

  await check("filters: all combined (status + payment + range + q)", async () => {
    const q = "Customer";
    const exp = oracleSorted(
      (s) =>
        s.status === "pending" &&
        s.pay === "cod" &&
        s.day >= "2026-03-10" &&
        s.day <= "2026-03-14" &&
        oracleSearch(q)(s)
    );
    ok(exp.length > 0, "combined oracle must be non-empty to be meaningful");
    const r = await listQuery({
      q,
      status: "pending",
      payment_method: "cod",
      from: "2026-03-10",
      to: "2026-03-14",
      pageSize: 100,
    });
    eq(r.ids, exp.map((s) => s.order_id));
    eq(r.total, exp.length);
    const exp2 = oracleSorted((s) => s.status === "delivered" && s.pay === "bank" && s.day === "2026-03-12");
    const r2 = await listQuery({
      status: "delivered",
      payment_method: "bank",
      from: "2026-03-12",
      to: "2026-03-12",
      pageSize: 100,
    });
    eq(r2.ids, exp2.map((s) => s.order_id));
  });

  await check("search: order_id substring, email, phone, name, unicode", async () => {
    for (const q of ["AO2-R05", "R010", "ao2-r09", "cust042@", "ao2.test", "+9230000", "Customer 1", "inject1", "Plus Payload"]) {
      const exp = oracleSorted(oracleSearch(q));
      const r = await listQuery({ q, pageSize: 100 });
      eq(r.total, exp.length, `q=${q} total`);
      eq((await allPages({ q }, 100)).ids, exp.map((s) => s.order_id), `q=${q}`);
      ok(r.total > 0, `q=${q} should match something`);
    }
    // Exact order-id substring -> exactly that row
    const one = await listQuery({ q: "AO2-R042" });
    eq(one.ids, ["AO2-R042"]);
    // Email search hits exactly one row
    const email = await listQuery({ q: "cust042@ao2.test" });
    eq(email.ids, ["AO2-R042"]);
    // Unicode names
    eq((await listQuery({ q: "محمد" })).ids, ["AO2-U2"]);
    eq((await listQuery({ q: "李雷" })).ids, ["AO2-U3"]);
    eq((await listQuery({ q: "Zoë" })).ids, ["AO2-U1"]);
    eq((await listQuery({ q: "Müller" })).ids, ["AO2-U1"]);
    // Trailing/leading whitespace is trimmed by parseOrderListQuery
    eq((await listQuery({ q: "  AO2-R042  " })).ids, ["AO2-R042"]);
  });

  await check("search: SQL wildcards % and _ are escaped", async () => {
    eq(escapeLikeWildcards("a%b_c\\d"), "a\\%b\\_c\\\\d");

    // "0%" literally exists only in "50% Off Fan"
    const pct = await listQuery({ q: "0%" });
    eq(pct.ids, ["AO2-W1"], "q='0%' matches only the literal-percent name");
    // Without escaping, '%0%%' would behave as 'contains 0' and match many rows.
    const [unescapedPct] = await pool.query(
      `SELECT COUNT(*) AS n FROM orders o WHERE ${SCOPE}
       AND (o.order_id LIKE ? OR o.customer_name LIKE ? OR o.customer_email LIKE ? OR o.customer_phone LIKE ?)`,
      ["%0%%", "%0%%", "%0%%", "%0%%"]
    );
    ok(Number(unescapedPct[0].n) > 50, "control: unescaped % matches far more than the escaped query");

    // "%%" literal only in Double%%Percent
    const dbl = await listQuery({ q: "%%" });
    eq(dbl.ids, ["AO2-W3"]);
    ok(dbl.total < 120, "q='%%' does not match everything");

    // "a_" literal only in data_set Buyer
    const us = await listQuery({ q: "a_" });
    eq(us.ids, ["AO2-W2"], "q='a_' matches only the literal underscore name");
    const [unescapedUs] = await pool.query(
      `SELECT COUNT(*) AS n FROM orders o WHERE ${SCOPE} AND o.order_id LIKE ?`,
      ["%a_%"]
    );
    eq(Number(unescapedUs[0].n), 120, "control: unescaped _ would match every order id (AO2-...)");

    // Oracle agreement for a few wildcard-ish needles
    for (const q of ["0%", "%%", "a_", "t_s", "%P", "_s"]) {
      const exp = oracleSorted(oracleSearch(q));
      eq((await allPages({ q }, 100)).ids, exp.map((s) => s.order_id), `oracle q=${q}`);
    }
    // Backslash is literal too
    eq((await listQuery({ q: "\\a" })).total, 0);
  });

  await check("export row count equals list total (same WHERE, LIMIT 10000)", async () => {
    eq(EXPORT_MAX, 10000);
    const queries = [
      {},
      { status: "pending" },
      { payment_method: "jazzcash" },
      { status: "confirmed", payment_method: "bank" },
      { from: "2026-03-11", to: "2026-03-12" },
      { q: "Customer 1" },
      { q: "0%" },
      { q: "zzzz-nothing" },
      { status: "cancelled", from: "2026-03-10", to: "2026-03-15", q: "Customer" },
    ];
    for (const query of queries) {
      const list = await listQuery({ ...query, pageSize: 100 });
      const exp = await exportIds(query);
      eq(exp.ids.length, list.total, `export rows == list total for ${JSON.stringify(query)}`);
      eq(exp.total, list.total);
      eq(exp.truncated, false);
      // Export is not paginated and uses the same ordering as the list.
      const paged = await allPages(query, 10);
      eq(exp.ids, paged.ids, `export order == concatenated pages for ${JSON.stringify(query)}`);
    }
    // Cap behaviour (documented): truncated iff total > EXPORT_MAX; fetch limit = min(total, cap).
    eq(Math.min(25_000, EXPORT_MAX), 10_000);
    eq(Math.min(120, EXPORT_MAX), 120);
    eq(25_000 > EXPORT_MAX, true);
    eq(120 > EXPORT_MAX, false);
    // Simulate a truncated export with a small LIMIT: still newest-first, strict prefix of the full set.
    const full = await exportIds({});
    const capped = await exportIds({}, 50);
    eq(capped.ids.length, 50);
    ok(capped.ids.length < capped.total, "capped export returns fewer rows than total");
    eq(capped.ids, full.ids.slice(0, 50), "capped export is the newest-N prefix");
  });

  await check("CSV formula-injection escaping (csvEscapeCell)", async () => {
    eq(csvEscapeCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
    eq(csvEscapeCell("=1+1"), "'=1+1");
    eq(csvEscapeCell("+1"), "'+1");
    eq(csvEscapeCell("-1"), "'-1");
    eq(csvEscapeCell("@x"), "'@x");
    eq(csvEscapeCell("\tfoo"), "'\tfoo");
    eq(csvEscapeCell("\rfoo"), `"'\rfoo"`); // CR also forces RFC-4180 quoting
    eq(csvEscapeCell(-5), "'-5"); // numeric negatives are prefixed too (documented behaviour)
    // Pass-through and normal RFC-4180 quoting
    eq(csvEscapeCell("abc"), "abc");
    eq(csvEscapeCell("a=b"), "a=b"); // only the first character matters
    eq(csvEscapeCell(null), "");
    eq(csvEscapeCell(undefined), "");
    eq(csvEscapeCell(0), "0");
    eq(csvEscapeCell("1234.50"), "1234.50");
    eq(csvEscapeCell("a,b"), '"a,b"');
    eq(csvEscapeCell('say "hi"'), '"say ""hi"""');
    eq(csvEscapeCell("line1\nline2"), '"line1\nline2"');
    eq(csvEscapeCell("=a,b"), `"'=a,b"`); // prefix first, then quote
    eq(csvEscapeCell("محمد علی"), "محمد علی");

    // Real rows from the DB: no exported cell may begin with a formula trigger.
    const [rows] = await pool.query(
      "SELECT order_id, customer_name, customer_email FROM orders WHERE order_id IN ('AO2-I1','AO2-I2') ORDER BY id"
    );
    eq(rows.length, 2);
    const cells = rows.flatMap((r) => [r.order_id, r.customer_name, r.customer_email].map(csvEscapeCell));
    for (const c of cells) {
      const bare = c.startsWith('"') ? c.slice(1) : c;
      ok(!/^[=+\-@\t\r]/.test(bare), `unsafe CSV cell survived: ${JSON.stringify(c)}`);
    }
    ok(cells.includes("'=cmd|' /C calc'!A0"));
    ok(cells.includes("'+1 Plus Payload"));
  });

  await check("detail fields: snapshot vs legacy (query snapshots)", async () => {
    // Mirrors pages/api/admin-orders.ts handleDetail.
    async function detail(orderId) {
      const [orderRows] = await pool.query("SELECT * FROM orders WHERE order_id = ? LIMIT 1", [orderId]);
      const order = orderRows[0] || null;
      if (!order) return null;
      const [items] = await pool.query(
        `SELECT id, product_id, product_name, price, quantity, (price * quantity) AS line_total
         FROM order_items WHERE order_id = ? ORDER BY id ASC`,
        [orderId]
      );
      let tax = { label: "Tax", vat_amount: Number(order.vat_amount || 0), lines: null, has_snapshot: false };
      const [snapRows] = await pool.query(
        "SELECT tax_label, vat_amount, snapshot_json FROM order_tax_snapshots WHERE order_id = ? LIMIT 1",
        [orderId]
      );
      const snap = snapRows[0];
      if (snap) {
        // mysql2 may return JSON-typed columns already parsed (API handles both shapes).
        const parsed = typeof snap.snapshot_json === "string" ? JSON.parse(snap.snapshot_json) : snap.snapshot_json;
        tax = {
          label: String(snap.tax_label).trim() || "Tax",
          vat_amount: Number(snap.vat_amount ?? order.vat_amount ?? 0),
          lines: Array.isArray(parsed.lines) ? parsed.lines : null,
          has_snapshot: true,
        };
      }
      return { order, items, tax };
    }

    // R003: i%3==0 -> snapshot
    const snapSeed = seed.find((s) => s.order_id === "AO2-R003");
    const d = await detail("AO2-R003");
    eq(d.tax.has_snapshot, true);
    eq(d.tax.label, snapSeed.snapshot.label);
    eq(d.tax.vat_amount, Number(snapSeed.snapshot.vat));
    ok(Array.isArray(d.tax.lines) && d.tax.lines.length === 1, "snapshot lines parsed");
    eq(d.order.status, snapSeed.status);
    eq(d.items.length, snapSeed.items.length);
    eq(d.items[0].product_name, snapSeed.items[0].name);
    eq(Number(d.items[0].line_total), 100 * snapSeed.items[0].qty);

    // R004: no snapshot, vat set -> label falls back to "Tax"
    const d4 = await detail("AO2-R004");
    eq(d4.tax.has_snapshot, false);
    eq(d4.tax.label, "Tax");
    eq(d4.tax.vat_amount, 15);

    // Legacy: NULL vat_amount, no snapshot -> 0 / "Tax" / has_snapshot=false
    for (let i = 1; i <= 5; i += 1) {
      const id = `AO2-L${pad(i, 2)}`;
      const dl = await detail(id);
      eq(dl.order.vat_amount, null, `${id} vat_amount stays NULL`);
      eq(dl.tax.has_snapshot, false);
      eq(dl.tax.label, "Tax");
      eq(dl.tax.vat_amount, 0);
      eq(dl.items.length, 1);
    }
    eq(await detail("AO2-DOES-NOT-EXIST"), null);

    // List-side helpers
    const ids = seed.filter((s) => s.kind === "regular" || s.kind === "legacy").map((s) => s.order_id);
    const labels = await taxLabelsForOrderIds(pool, ids);
    for (const s of seed.filter((x) => ids.includes(x.order_id))) {
      if (s.snapshot) eq(labels[s.order_id], s.snapshot.label, `${s.order_id} label`);
      else eq(labels[s.order_id], undefined, `${s.order_id} has no label -> UI/CSV falls back to "Tax"`);
    }
    const meta = await itemsMetaForOrderIds(pool, ["AO2-R001", "AO2-R002", "AO2-R003", "AO2-U1"]);
    eq(meta["AO2-R001"].items_count, 2);
    eq(meta["AO2-R002"].items_count, 3);
    eq(meta["AO2-R001"].items_list, "Item 1-1 x 1; Item 1-2 x 2");
    eq(meta["AO2-R003"].items_count, 1);
    eq(meta["AO2-U1"], undefined, "orders without items have no meta entry (-> empty string)");
    eq(await itemsMetaForOrderIds(pool, []), {});
    eq(await taxLabelsForOrderIds(pool, []), {});
  });

  await check("LIKE ESCAPE clause executes against MariaDB", async () => {
    // Guards the '\\\\' string-literal escaping inside buildOrderWhere.
    const { sql, params } = buildOrderWhere(parseOrderListQuery({ q: "50% Off" }).filters, "o");
    ok(/ESCAPE/.test(sql));
    eq(params.length, 4);
    eq(params[0], "%50\\% Off%");
    const [rows] = await pool.query(`SELECT order_id FROM orders o ${scoped(sql)}`, params);
    eq(idsOf(rows), ["AO2-W1"]);
    // Also valid with no alias
    const bare = buildOrderWhere(parseOrderListQuery({ status: "pending" }).filters, "");
    ok(bare.sql.includes("status = ?") && !bare.sql.includes("o."));
  });

  // Final sanity: nothing outside AO2-% was touched (DASH-* rows from other suites remain).
  const [[outside]] = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE order_id NOT LIKE 'AO2-%'");

  await cleanup();
  const [[left]] = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE order_id LIKE 'AO2-%'");
  const [[leftItems]] = await pool.query("SELECT COUNT(*) AS n FROM order_items WHERE order_id LIKE 'AO2-%'");
  const [[leftSnaps]] = await pool.query(
    "SELECT COUNT(*) AS n FROM order_tax_snapshots WHERE order_id LIKE 'AO2-%'"
  );
  eq([Number(left.n), Number(leftItems.n), Number(leftSnaps.n)], [0, 0, 0], "cleanup removed all AO2-% rows");

  console.log(
    "AO2_DB_PASS",
    JSON.stringify({
      seeded_orders: seed.length,
      seeded_items: seeded.items,
      seeded_snapshots: seeded.snapshots,
      legacy_rows: seed.filter((s) => s.kind === "legacy").length,
      non_seed_rows_untouched: Number(outside.n),
      sections: sections.length,
      section_names: sections,
      assertions,
      export_max: EXPORT_MAX,
    })
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error("AO2_DB_FAIL", e);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
