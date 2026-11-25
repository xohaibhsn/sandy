#!/usr/bin/env node
/**
 * sandy-qa local-db-bootstrap — build a complete LOCAL test DB from repo migrations
 * + owner/seed-delivery-ops.sql + scripts/qa/fixtures/local-fixture.sql.
 *
 * LOCAL ONLY. Hard-coded guards refuse anything that is not:
 *   host ∈ {127.0.0.1, localhost} AND port === 3307 AND database name starts with sandy_local
 *
 * Connection settings come ONLY from CLI flags or an explicit --env-file path.
 * Passwords are never printed.
 *
 * Exit: 0 = ok, 1 = bootstrap failure after guards, 2 = guard refusal / usage.
 * --self-test exercises guards offline (no network / no DB).
 *
 * Never point this at production.
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

export function parseArgs(argv) {
  const out = {
    host: null,
    port: null,
    user: null,
    password: null,
    database: null,
    envFile: null,
    adminPassword: null,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--self-test") out.selfTest = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--host") out.host = next();
    else if (a === "--port") out.port = Number(next());
    else if (a === "--user") out.user = next();
    else if (a === "--password") out.password = next();
    else if (a === "--database" || a === "--db") out.database = next();
    else if (a === "--env-file") out.envFile = next();
    else if (a === "--admin-password") out.adminPassword = next();
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

export function loadEnvFile(filePath) {
  if (!filePath) return {};
  if (!existsSync(filePath)) throw new Error(`env file not found: ${filePath}`);
  const map = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map[k] = v;
  }
  return map;
}

export function resolveConfig(args, envMap = {}) {
  const host = args.host || envMap.DB_HOST || null;
  const port = args.port != null && !Number.isNaN(args.port) ? args.port : Number(envMap.DB_PORT || NaN);
  const user = args.user || envMap.DB_USER || null;
  const password = args.password || envMap.DB_PASSWORD || envMap.SANDY_TEST_DB_PASSWORD || null;
  const database = args.database || envMap.DB_NAME || null;
  return { host, port, user, password, database, adminPassword: args.adminPassword || null };
}

/**
 * Returns null when OK, or a refusal reason string when the target is unsafe.
 * Guards run BEFORE any DB driver is loaded.
 */
export function guardLocalOnly({ host, port, database }) {
  if (!host || (host !== "127.0.0.1" && host !== "localhost")) {
    return `refusing non-local host (got ${String(host)})`;
  }
  if (port !== 3307) {
    return `refusing non-3307 port (got ${String(port)})`;
  }
  if (!database || typeof database !== "string" || !database.startsWith("sandy_local")) {
    return `refusing database name that does not start with sandy_local (got ${String(database)})`;
  }
  return null;
}

function migrationFiles() {
  const dir = path.join(repoRoot, "migrations");
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.+\.sql$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

async function hashPassword(password) {
  const bcrypt = (await import("bcryptjs")).default;
  return bcrypt.hash(password, 12);
}

async function runBootstrap(cfg) {
  // Driver loaded ONLY after guards pass
  const mysql = require("mysql2/promise");
  const adminPassword = cfg.adminPassword || "zz-local-admin-pass";
  const passwordHash = await hashPassword(adminPassword);

  // Connect without database to DROP/CREATE
  const rootConn = await mysql.createConnection({
    host: cfg.host === "localhost" ? "127.0.0.1" : cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    multipleStatements: true,
    charset: "utf8mb4",
  });

  const db = cfg.database;
  try {
    await rootConn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await rootConn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await rootConn.end();
  }

  const conn = await mysql.createConnection({
    host: cfg.host === "localhost" ? "127.0.0.1" : cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: db,
    multipleStatements: true,
    charset: "utf8mb4",
  });

  try {
    const [[{ d }]] = await conn.query("SELECT DATABASE() AS d");
    if (d !== db) throw new Error("database mismatch after connect");

    for (const file of migrationFiles()) {
      const sql = readFileSync(file, "utf8");
      process.stdout.write(`apply ${path.basename(file)} ... `);
      await conn.query(sql);
      console.log("ok");
    }

    const seedPath = path.join(repoRoot, "owner", "seed-delivery-ops.sql");
    process.stdout.write("apply owner/seed-delivery-ops.sql ... ");
    await conn.query(readFileSync(seedPath, "utf8"));
    console.log("ok");

    const fixturePath = path.join(repoRoot, "scripts", "qa", "fixtures", "local-fixture.sql");
    process.stdout.write("apply local-fixture.sql ... ");
    await conn.query(readFileSync(fixturePath, "utf8"));
    console.log("ok");

    // Staff row (hash never stored in repo)
    await conn.query(
      `INSERT INTO admin_staff (name, email, password_hash, role, active)
       SELECT 'ZZ Local Admin', 'zz-local-admin@example.invalid', ?, 'super_admin', 1
       FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM admin_staff WHERE email = 'zz-local-admin@example.invalid')`,
      [passwordHash]
    );
    // If row exists from a prior partial run, refresh hash
    await conn.query(
      `UPDATE admin_staff SET password_hash = ?, role = 'super_admin', active = 1, name = 'ZZ Local Admin'
       WHERE email = 'zz-local-admin@example.invalid'`,
      [passwordHash]
    );

    const [tables] = await conn.query(
      `SELECT TABLE_NAME AS t, TABLE_ROWS AS approx_rows
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY TABLE_NAME`
    );
    const counts = {};
    for (const row of tables) {
      const [[c]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${row.t}\``);
      counts[row.t] = c.c;
    }

    console.log("bootstrap summary:");
    console.log(`  database=${db}`);
    console.log(`  tables=${Object.keys(counts).length}`);
    for (const [t, c] of Object.entries(counts)) {
      console.log(`  ${t}: ${c}`);
    }
    console.log("  staff: zz-local-admin@example.invalid (super_admin)");
    console.log("  product: Phone Case id=1 slug=phone-case");
    console.log("  blog: zz-local-post");
    return EXIT_OK;
  } finally {
    await conn.end();
  }
}

function selfTest() {
  const cases = [
    [{ host: "sandy.com.pk", port: 3307, database: "sandy_local_x" }, true],
    [{ host: "127.0.0.1", port: 3306, database: "sandy_local_x" }, true],
    [{ host: "127.0.0.1", port: 3307, database: "u992747032_sandy" }, true],
    [{ host: "127.0.0.1", port: 3307, database: "sandy_mig_orders" }, true],
    [{ host: "localhost", port: 3307, database: "sandy_local_b53" }, false],
    [{ host: "127.0.0.1", port: 3307, database: "sandy_local_b53" }, false],
  ];
  for (const [cfg, expectRefuse] of cases) {
    const reason = guardLocalOnly(cfg);
    const refused = reason != null;
    if (refused !== expectRefuse) {
      console.error("self-test FAIL", cfg, "reason=", reason, "expectedRefuse=", expectRefuse);
      return EXIT_FAIL;
    }
  }
  // Prove guards run with no mysql import side effect in this path:
  // (caller checks that mysql2 is not required when --self-test alone)
  console.log("local-db-bootstrap --self-test OK (guards refuse non-local / non-sandy_local)");
  return EXIT_OK;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`local-db-bootstrap: ${err.message}`);
    return EXIT_USAGE;
  }
  if (args.help) {
    console.log(
      "Usage: node scripts/qa/local-db-bootstrap.mjs --env-file <path> [--database sandy_local_*] [--admin-password <pw>]\n" +
        "   or: --host 127.0.0.1 --port 3307 --user ... --password ... --database sandy_local_*\n" +
        "Guards: host localhost|127.0.0.1, port 3307, database name starts with sandy_local.\n" +
        "LOCAL ONLY — never point at production."
    );
    return EXIT_OK;
  }
  if (args.selfTest) return selfTest();

  let envMap = {};
  try {
    envMap = loadEnvFile(args.envFile);
  } catch (err) {
    console.error(`local-db-bootstrap: ${err.message}`);
    return EXIT_USAGE;
  }
  const cfg = resolveConfig(args, envMap);
  const reason = guardLocalOnly(cfg);
  if (reason) {
    console.error(`local-db-bootstrap: ${reason}`);
    return EXIT_USAGE;
  }
  if (!cfg.user || !cfg.password) {
    console.error("local-db-bootstrap: user/password required via flags or --env-file");
    return EXIT_USAGE;
  }

  try {
    return await runBootstrap(cfg);
  } catch (err) {
    console.error(`local-db-bootstrap: failed: ${err && err.message ? err.message : err}`);
    return EXIT_FAIL;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
