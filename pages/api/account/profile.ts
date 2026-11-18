import type { NextApiRequest, NextApiResponse } from "next";
import pool from "../../../lib/db";
import { requireAccountCustomer } from "../../../lib/accountApi";
import { normaliseEmail } from "../../../lib/customerIdentity";
import { CUSTOMER_TEXTS } from "../../../lib/customerTexts";

const NAME_MAX = 255;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const me = await requireAccountCustomer(req, res);
  if (!me) return;

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "PATCH") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isPlainObject(req.body)) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const body = req.body;
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasEmail = Object.prototype.hasOwnProperty.call(body, "email");
  if (!hasName && !hasEmail) {
    return res.status(400).json({ error: "Invalid request" });
  }

  let name = me.name;
  let email = me.email;
  let emailNorm: string | null = null;
  let emailChanged = false;

  if (hasName) {
    if (body.name === null) {
      name = null;
    } else if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      if (trimmed.length > NAME_MAX) return res.status(400).json({ error: "Invalid request" });
      name = trimmed || null;
    } else {
      return res.status(400).json({ error: "Invalid request" });
    }
  }

  if (hasEmail) {
    emailChanged = true;
    if (body.email === null || body.email === "") {
      email = null;
      emailNorm = null;
    } else if (typeof body.email === "string") {
      emailNorm = normaliseEmail(body.email);
      if (!emailNorm) return res.status(400).json({ error: "Invalid request" });
      email = body.email.trim();
    } else {
      return res.status(400).json({ error: "Invalid request" });
    }
  }

  try {
    // Email is stored as given and is NOT verified; it is never used for login.
    if (emailChanged) {
      await pool.query(`UPDATE customers SET name = ?, email = ?, email_norm = ? WHERE id = ?`, [
        name,
        email,
        emailNorm,
        me.id,
      ]);
    } else {
      await pool.query(`UPDATE customers SET name = ? WHERE id = ?`, [name, me.id]);
    }
    return res.status(200).json({
      ok: true,
      customer: { id: me.id, phone_norm: me.phone_norm, name, email },
    });
  } catch (err) {
    console.error("[api/account/profile] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: CUSTOMER_TEXTS.ACCOUNT_GENERIC_ERROR });
  }
}
