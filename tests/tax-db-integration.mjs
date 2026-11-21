/**
 * Local MariaDB integration for TAX-CONFIG-01 (tables + engine).
 * Host 127.0.0.1:3307 / sandy_test_local. No production.
 */
import mysql from "mysql2/promise";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

// Load pure engine via node --experimental-strip-types helper
function loadEngine() {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e",
      `import { computeCartTax } from ${JSON.stringify(pathToFileURL(path.join(root, "lib/taxEngine.ts")).href)};
       const cfg = JSON.parse(process.env.TAX_CFG);
       const input = JSON.parse(process.env.TAX_INPUT);
       const out = computeCartTax({ ...input, config: cfg });
       process.stdout.write(JSON.stringify(out));`],
    {
      env: process.env,
      encoding: "utf8",
      cwd: root,
    }
  );
  return r;
}

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "sandy_test",
  password: process.env.SANDY_TEST_DB_PASSWORD,
  database: "sandy_test_local",
});

async function buildConfig(asOf) {
  const [classes] = await pool.query("SELECT * FROM tax_classes");
  const [rateRows] = await pool.query("SELECT * FROM tax_rates");
  const [ruleRows] = await pool.query(
    "SELECT * FROM tax_rules WHERE effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1",
    [asOf]
  );
  assert.ok(classes.length >= 3);
  assert.ok(rateRows.length >= 3);
  assert.ok(ruleRows[0]);
  const physical = classes.find((c) => c.slug === "physical-goods");
  assert.ok(physical);
  const rates = {};
  for (const c of classes) {
    const candidates = rateRows
      .filter((r) => r.tax_class_id === c.id && new Date(r.effective_from) <= asOf)
      .sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from) || b.id - a.id);
    if (candidates[0]) {
      rates[c.id] = {
        id: candidates[0].id,
        tax_class_id: candidates[0].tax_class_id,
        rate_percent: Number(candidates[0].rate_percent),
        effective_from: candidates[0].effective_from,
      };
    }
  }
  return {
    as_of: asOf.toISOString(),
    classes: classes.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      applies_to: c.applies_to,
      active: !!c.active,
      sort_order: c.sort_order,
    })),
    rates,
    rules: {
      id: ruleRows[0].id,
      tax_base: ruleRows[0].tax_base,
      shipping_taxable: !!ruleRows[0].shipping_taxable,
      rounding: ruleRows[0].rounding,
      tax_label: ruleRows[0].tax_label,
      prices_include_tax: !!ruleRows[0].prices_include_tax,
      effective_from: ruleRows[0].effective_from,
    },
    default_class_id: physical.id,
  };
}

function runCart(cfg, input) {
  process.env.TAX_CFG = JSON.stringify(cfg);
  process.env.TAX_INPUT = JSON.stringify(input);
  const r = loadEngine();
  if (r.status !== 0) {
    throw new Error(`engine failed: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

async function main() {
  const asOf = new Date("2026-01-01T00:00:00Z");
  const cfg = await buildConfig(asOf);
  assert.equal(cfg.rules.tax_label, "GST");

  const physicalId = cfg.default_class_id;
  const digital = cfg.classes.find((c) => c.slug === "digital-products");

  const coupon = runCart(cfg, {
    lines: [{ key: 1, amount: 999, tax_class_id: physicalId }],
    discount_amount: 99.9,
    shipping_amount: 0,
    destination: "domestic",
  });
  assert.equal(coupon.ok, true, JSON.stringify(coupon));
  assert.equal(coupon.snapshot.vat_amount, 153);

  const multi = runCart(cfg, {
    lines: [
      { key: 1, amount: 100, tax_class_id: physicalId },
      { key: 2, amount: 100, tax_class_id: digital.id },
    ],
    discount_amount: 0,
    shipping_amount: 0,
    destination: "domestic",
  });
  assert.equal(multi.ok, true);
  assert.equal(multi.snapshot.vat_amount, 34);

  // rate change after existing snapshot
  await pool.query(
    "INSERT INTO tax_rates (tax_class_id, rate_percent, effective_from, created_by) VALUES (?,?,?,?)",
    [physicalId, 20.0, "2026-06-01 00:00:00", "integration"]
  );
  const oldVat = coupon.snapshot.vat_amount;
  const cfgNew = await buildConfig(new Date("2026-07-01T00:00:00Z"));
  const newer = runCart(cfgNew, {
    lines: [{ key: 1, amount: 999, tax_class_id: physicalId }],
    discount_amount: 99.9,
    shipping_amount: 0,
    destination: "domestic",
  });
  assert.equal(newer.ok, true);
  assert.notEqual(newer.snapshot.vat_amount, oldVat);
  assert.equal(oldVat, 153);

  // tables missing
  await pool.query("RENAME TABLE tax_classes TO tax_classes_bak");
  let missing = false;
  try {
    await pool.query("SELECT 1 FROM tax_classes LIMIT 1");
  } catch {
    missing = true;
  }
  assert.equal(missing, true);
  await pool.query("RENAME TABLE tax_classes_bak TO tax_classes");

  console.log("DB_INTEGRATION_PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
