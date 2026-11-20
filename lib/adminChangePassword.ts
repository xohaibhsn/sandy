/**
 * Self-service staff password-change validation (ADMIN-LOGIN-02).
 * Shared by the API route and the My Account Security panel helpers.
 */

export const ADMIN_NEW_PASSWORD_MIN = 12;
export const ADMIN_NEW_PASSWORD_MAX = 200;

export const MASTER_PASSWORD_HOSTING_MESSAGE =
  "The master password is managed in hosting settings.";

export const MASTER_ACCOUNT_SECURITY_WARNING =
  "You are signed in with the shared master admin login. Create your own super_admin account under Staff Users, then remove ADMIN_PASSWORD from hosting settings.";

export type PasswordChangeValidationOk = {
  ok: true;
  currentPassword: string;
  newPassword: string;
};

export type PasswordChangeValidationErr = {
  ok: false;
  error: string;
};

export type PasswordChangeValidation = PasswordChangeValidationOk | PasswordChangeValidationErr;

/**
 * Server-side body validation for POST /api/admin-change-password.
 * Does not touch the database or compare against a stored hash.
 */
export function validateAdminPasswordChangeInput(body: {
  currentPassword?: unknown;
  newPassword?: unknown;
}): PasswordChangeValidation {
  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return { ok: false, error: "Current password and new password are required" };
  }
  if (newPassword.length < ADMIN_NEW_PASSWORD_MIN) {
    return {
      ok: false,
      error: `New password must be at least ${ADMIN_NEW_PASSWORD_MIN} characters`,
    };
  }
  if (newPassword.length > ADMIN_NEW_PASSWORD_MAX) {
    return {
      ok: false,
      error: `New password must be at most ${ADMIN_NEW_PASSWORD_MAX} characters`,
    };
  }
  if (newPassword === currentPassword) {
    return {
      ok: false,
      error: "New password must be different from the current password",
    };
  }
  return { ok: true, currentPassword, newPassword };
}

/**
 * Client-side form checks (current + new + confirm) before calling the API.
 * Returns an error message, or null when the form looks valid.
 */
export function validatePasswordChangeForm(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string
): string | null {
  if (!currentPassword || !newPassword || !confirmPassword) {
    return "All fields are required";
  }
  if (newPassword.length < ADMIN_NEW_PASSWORD_MIN) {
    return `New password must be at least ${ADMIN_NEW_PASSWORD_MIN} characters`;
  }
  if (newPassword.length > ADMIN_NEW_PASSWORD_MAX) {
    return `New password must be at most ${ADMIN_NEW_PASSWORD_MAX} characters`;
  }
  if (newPassword === currentPassword) {
    return "New password must be different from the current password";
  }
  if (newPassword !== confirmPassword) {
    return "New password and confirmation do not match";
  }
  return null;
}
