import type { NextApiRequest, NextApiResponse } from "next";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../../lib/db";
import { requireAccountCustomer } from "../../../lib/accountApi";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";

const MAX_ADDRESSES = 20;

const FIELD_MAX = {
  label: 60,
  full_name: 255,
  phone: 50,
  line1: 500,
  line2: 500,
  city: 100,
  province: 100,
  postcode: 100,
} as const;

type AddressFields = {
  label: string | null;
  full_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  province: string | null;
  postcode: string | null;
};

const SELECT_COLUMNS =
  "id, label, full_name, phone, line1, line2, city, province, postcode, is_default, created_at, updated_at";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** String or nullish only; trimmed; over-length rejected. */
function readText(value: unknown, max: number): { ok: true; value: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length > max) return { ok: false };
  return { ok: true, value: trimmed };
}

/**
 * Validate a full address (same required set as checkout: name, phone, line1, city).
 * `source` supplies raw values; `fallback` (PATCH) supplies stored values for omitted keys.
 */
function parseAddress(
  source: Record<string, unknown>,
  fallback?: AddressFields
): AddressFields | null {
  const pick = (key: keyof AddressFields, max: number): string | null => {
    const raw = Object.prototype.hasOwnProperty.call(source, key)
      ? source[key]
      : fallback
        ? fallback[key]
        : undefined;
    const r = readText(raw, max);
    return r.ok ? r.value : null;
  };

  const full_name = pick("full_name", FIELD_MAX.full_name);
  const phone = pick("phone", FIELD_MAX.phone);
  const line1 = pick("line1", FIELD_MAX.line1);
  const city = pick("city", FIELD_MAX.city);
  const label = pick("label", FIELD_MAX.label);
  const line2 = pick("line2", FIELD_MAX.line2);
  const province = pick("province", FIELD_MAX.province);
  const postcode = pick("postcode", FIELD_MAX.postcode);

  if (
    full_name === null ||
    phone === null ||
    line1 === null ||
    city === null ||
    label === null ||
    line2 === null ||
    province === null ||
    postcode === null
  ) {
    return null;
  }
  if (!full_name || !phone || !line1 || !city) return null;

  return {
    label: label || null,
    full_name,
    phone,
    line1,
    line2: line2 || null,
    city,
    province: province || null,
    postcode: postcode || null,
  };
}

/** is_default flag: 0/1/true/false only. Returns undefined when absent, null when invalid. */
function parseDefaultFlag(value: unknown): 0 | 1 | undefined | null {
  if (value === undefined) return undefined;
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0" || value === null) return 0;
  return null;
}

function parseAddressId(raw: unknown): number | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function requestId(req: NextApiRequest, body: Record<string, unknown>): number | null {
  const fromBody = parseAddressId(body.id);
  if (fromBody !== null) return fromBody;
  const q = req.query.id;
  return parseAddressId(Array.isArray(q) ? q[0] : q);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const me = await requireAccountCustomer(req, res);
  if (!me) return;

  res.setHeader("Cache-Control", "no-store");

  const method = String(req.method || "").toUpperCase();
  const body: Record<string, unknown> = isPlainObject(req.body) ? req.body : {};

  try {
    if (method === "GET") {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${SELECT_COLUMNS} FROM customer_addresses
         WHERE customer_id = ?
         ORDER BY is_default DESC, id DESC`,
        [me.id]
      );
      return res.status(200).json({ addresses: Array.isArray(rows) ? rows : [] });
    }

    if (method === "POST") {
      const fields = parseAddress(body);
      const flag = parseDefaultFlag(body.is_default);
      if (!fields || flag === null) {
        return res.status(400).json({ error: "Invalid request" });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        // Serialize per-customer address writes.
        await connection.query(`SELECT id FROM customers WHERE id = ? FOR UPDATE`, [me.id]);

        const [countRows] = await connection.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?`,
          [me.id]
        );
        const existing = Number(countRows?.[0]?.n) || 0;
        if (existing >= MAX_ADDRESSES) {
          await connection.rollback();
          return res.status(400).json({ error: "Invalid request" });
        }

        // The first address is always the default.
        const makeDefault = flag === 1 || existing === 0 ? 1 : 0;
        if (makeDefault === 1) {
          await connection.query(
            `UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?`,
            [me.id]
          );
        }

        const [result] = await connection.query<ResultSetHeader>(
          `INSERT INTO customer_addresses
             (customer_id, label, full_name, phone, line1, line2, city, province, postcode, is_default)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            me.id,
            fields.label,
            fields.full_name,
            fields.phone,
            fields.line1,
            fields.line2,
            fields.city,
            fields.province,
            fields.postcode,
            makeDefault,
          ]
        );
        await connection.commit();
        return res.status(201).json({ ok: true, id: Number(result.insertId) });
      } catch (err) {
        try {
          await connection.rollback();
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        connection.release();
      }
    }

    if (method === "PATCH") {
      const id = requestId(req, body);
      const flag = parseDefaultFlag(body.is_default);
      if (id === null || flag === null) {
        return res.status(400).json({ error: "Invalid request" });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(`SELECT id FROM customers WHERE id = ? FOR UPDATE`, [me.id]);

        const [rows] = await connection.query<RowDataPacket[]>(
          `SELECT ${SELECT_COLUMNS} FROM customer_addresses
           WHERE id = ? AND customer_id = ? LIMIT 1 FOR UPDATE`,
          [id, me.id]
        );
        const current = Array.isArray(rows) ? rows[0] : undefined;
        if (!current) {
          await connection.rollback();
          return res.status(404).json({ error: "Not found" });
        }

        const stored: AddressFields = {
          label: current.label ?? null,
          full_name: String(current.full_name ?? ""),
          phone: String(current.phone ?? ""),
          line1: String(current.line1 ?? ""),
          line2: current.line2 ?? null,
          city: String(current.city ?? ""),
          province: current.province ?? null,
          postcode: current.postcode ?? null,
        };
        const fields = parseAddress(body, stored);
        if (!fields) {
          await connection.rollback();
          return res.status(400).json({ error: "Invalid request" });
        }

        // A default can only be moved by choosing another default (never leave zero defaults).
        const wasDefault = Number(current.is_default) === 1;
        const makeDefault = flag === 1 || wasDefault ? 1 : 0;
        if (makeDefault === 1) {
          await connection.query(
            `UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ? AND id <> ?`,
            [me.id, id]
          );
        }

        await connection.query(
          `UPDATE customer_addresses
           SET label = ?, full_name = ?, phone = ?, line1 = ?, line2 = ?, city = ?, province = ?,
               postcode = ?, is_default = ?
           WHERE id = ? AND customer_id = ?`,
          [
            fields.label,
            fields.full_name,
            fields.phone,
            fields.line1,
            fields.line2,
            fields.city,
            fields.province,
            fields.postcode,
            makeDefault,
            id,
            me.id,
          ]
        );
        await connection.commit();
        return res.status(200).json({ ok: true });
      } catch (err) {
        try {
          await connection.rollback();
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        connection.release();
      }
    }

    if (method === "DELETE") {
      const id = requestId(req, body);
      if (id === null) {
        return res.status(400).json({ error: "Invalid request" });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(`SELECT id FROM customers WHERE id = ? FOR UPDATE`, [me.id]);

        const [rows] = await connection.query<RowDataPacket[]>(
          `SELECT id, is_default FROM customer_addresses WHERE id = ? AND customer_id = ? LIMIT 1 FOR UPDATE`,
          [id, me.id]
        );
        const current = Array.isArray(rows) ? rows[0] : undefined;
        if (!current) {
          await connection.rollback();
          return res.status(404).json({ error: "Not found" });
        }

        await connection.query(`DELETE FROM customer_addresses WHERE id = ? AND customer_id = ?`, [
          id,
          me.id,
        ]);

        // Keep exactly one default when addresses remain: promote the newest.
        if (Number(current.is_default) === 1) {
          await connection.query(
            `UPDATE customer_addresses SET is_default = 1
             WHERE customer_id = ?
             ORDER BY id DESC
             LIMIT 1`,
            [me.id]
          );
        }
        await connection.commit();
        return res.status(200).json({ ok: true });
      } catch (err) {
        try {
          await connection.rollback();
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        connection.release();
      }
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[api/account/addresses] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: CUSTOMER_TEXTS.ACCOUNT_GENERIC_ERROR });
  }
}
