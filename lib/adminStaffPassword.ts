import crypto from "crypto";
import bcrypt from "bcryptjs";

export const ADMIN_STAFF_BCRYPT_ROUNDS = 12;

const LEGACY_SHA256_RE = /^[a-f0-9]{64}$/i;

export type AdminStaffPasswordCheck = {
  valid: boolean;
  upgradedHash?: string;
};

function sha256Hex(password: string): string {
  return crypto.createHash("sha256").update(password, "utf8").digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function isBcryptHash(stored: string): boolean {
  return stored.startsWith("$2");
}

function needsBcryptUpgrade(stored: string): boolean {
  try {
    return bcrypt.getRounds(stored) < ADMIN_STAFF_BCRYPT_ROUNDS;
  } catch {
    return false;
  }
}

export async function hashAdminStaffPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ADMIN_STAFF_BCRYPT_ROUNDS);
}

/**
 * Verify a submitted staff password against a stored hash.
 * Legacy SHA-256 and under-cost bcrypt hashes return an upgraded bcrypt hash
 * when the password is correct.
 */
export async function verifyAdminStaffPassword(
  password: string,
  storedHash: string
): Promise<AdminStaffPasswordCheck> {
  const stored = String(storedHash || "");
  if (!stored) return { valid: false };

  if (isBcryptHash(stored)) {
    try {
      const ok = await bcrypt.compare(password, stored);
      if (!ok) return { valid: false };
      if (needsBcryptUpgrade(stored)) {
        return { valid: true, upgradedHash: await hashAdminStaffPassword(password) };
      }
      return { valid: true };
    } catch {
      return { valid: false };
    }
  }

  if (LEGACY_SHA256_RE.test(stored)) {
    const submittedLower = sha256Hex(password).toLowerCase();
    const storedLower = stored.toLowerCase();
    if (!timingSafeEqualHex(submittedLower, storedLower)) {
      return { valid: false };
    }
    return { valid: true, upgradedHash: await hashAdminStaffPassword(password) };
  }

  return { valid: false };
}
