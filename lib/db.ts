import mysql from 'mysql2/promise';

declare global {
  // eslint-disable-next-line no-var
  var _mysqlPool: mysql.Pool | undefined;
}

export function isDatabaseConfigured(): boolean {
  return !!(
    process.env.DB_HOST &&
    process.env.DB_USER &&
    process.env.DB_PASSWORD &&
    process.env.DB_NAME
  );
}

/**
 * Hostinger MySQL users are granted for localhost / IPv4, not IPv6.
 * Using srvXXX.hstgr.io from the app server itself goes out over IPv6
 * (e.g. 2a02:4780:…) and MySQL returns Access denied (using password: YES).
 */
function resolveDbHost(): string {
  const host = String(process.env.DB_HOST || '').trim();
  if (!host || host === 'localhost' || host === '::1') return '127.0.0.1';

  const hostingerRemote = /\.(hstgr\.io|hostinger\.[a-z]+)$/i.test(host);
  if (hostingerRemote && process.platform !== 'win32') return '127.0.0.1';

  return host;
}

function createPool(): mysql.Pool {
  if (!isDatabaseConfigured()) {
    throw new Error(
      'CRITICAL: Missing required DB environment variables. ' +
      'Set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME in the host environment (or .env.local).'
    );
  }

  return mysql.createPool({
    host:            resolveDbHost(),
    user:            process.env.DB_USER,
    password:        process.env.DB_PASSWORD,
    database:        process.env.DB_NAME,
    port:            Number(process.env.DB_PORT) || 3306,
    connectionLimit: 3,
    waitForConnections: true,
    queueLimit:      5,
    connectTimeout:  8000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
}

function getPool(): mysql.Pool {
  if (!global._mysqlPool) {
    global._mysqlPool = createPool();
  }
  return global._mysqlPool;
}

/**
 * Lazy pool: importing this module must not throw.
 * Hostinger (and similar) collect page data at build time without DB env vars.
 * The real connection is created on first query at runtime, after env is set.
 */
const pool = new Proxy({} as mysql.Pool, {
  get(_target, prop) {
    const real = getPool() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(real) : value;
  },
});

export default pool;
