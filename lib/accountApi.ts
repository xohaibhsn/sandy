/**
 * Shared helpers for /api/account/* routes: flag gate (404 when off) + customer require.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { loadAccountSettings } from "./accountSettings";
import { requireCustomer, type CustomerRecord } from "./customerAuth";

export function sendAccountNotFound(res: NextApiResponse): void {
  res.status(404).json({ error: "Not found" });
}

/** Returns true when accounts are enabled; otherwise sends 404 and returns false. */
export async function requireAccountsEnabled(
  res: NextApiResponse
): Promise<boolean> {
  const settings = await loadAccountSettings();
  if (!settings.accounts_enabled) {
    sendAccountNotFound(res);
    return false;
  }
  return true;
}

/** Flag gate then authenticated customer. */
export async function requireAccountCustomer(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<CustomerRecord | null> {
  if (!(await requireAccountsEnabled(res))) return null;
  return requireCustomer(req, res);
}
