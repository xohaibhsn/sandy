import pool from './db';

let ready = false;
let inFlight: Promise<void> | null = null;

/**
 * Ensures order_checkout_attempts exists.
 * Fail-closed: checkout must not proceed if this cannot be created.
 * DDL runs outside the order transaction.
 */
export async function ensureOrderIdempotencyTable(): Promise<void> {
  if (ready) return;

  if (!inFlight) {
    inFlight = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS order_checkout_attempts (
          idempotency_key VARCHAR(64) NOT NULL,
          request_fingerprint CHAR(64) NOT NULL,
          order_id VARCHAR(50) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (idempotency_key),
          UNIQUE KEY uq_order_checkout_attempts_order_id (order_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      ready = true;
    })().finally(() => {
      inFlight = null;
    });
  }

  try {
    await inFlight;
  } catch (err) {
    ready = false;
    throw err;
  }

  if (!ready) {
    throw new Error('order_checkout_attempts table is not ready');
  }
}
