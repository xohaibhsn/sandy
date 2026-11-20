"use client";

import { useEffect, useState } from "react";
import {
  MASTER_ACCOUNT_SECURITY_WARNING,
  validatePasswordChangeForm,
} from "@/lib/adminChangePassword";

type SessionInfo = {
  authenticated: boolean;
  role?: string;
  name?: string;
  isMaster?: boolean;
};

type Props = {
  /** Called after logout-all succeeds so the parent can show the login screen. */
  onLoggedOut: () => void;
};

const fieldStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  maxWidth: 360,
  padding: "10px 12px",
  border: "1px solid #E5E5E5",
  borderRadius: 8,
  fontSize: 14,
  background: "#fff",
  color: "#111",
  marginTop: 6,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#333",
  marginBottom: 14,
};

const btnPrimary: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  border: "none",
  background: "#5B21B6",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const btnDanger: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  border: "1px solid #DC2626",
  background: "#fff",
  color: "#DC2626",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const btnMuted: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  border: "1px solid #E5E5E5",
  background: "#F5F5F5",
  color: "#333",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

function clearLegacyAdminKeys() {
  try {
    localStorage.removeItem("sAdminSession");
    localStorage.removeItem("sAdminRole");
    localStorage.removeItem("sAdminName");
  } catch {
    /* ignore */
  }
}

export default function AccountSecurityPanel({ onLoggedOut }: Props) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [formOk, setFormOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin-session", { credentials: "same-origin" });
        const data = (await res.json()) as SessionInfo;
        if (cancelled) return;
        if (!data?.authenticated) {
          setLoadError("Not signed in.");
          setInfo(null);
          return;
        }
        setInfo(data);
      } catch {
        if (!cancelled) {
          setLoadError("Could not load account session.");
          setInfo(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    setFormOk("");
    const clientErr = validatePasswordChangeForm(
      currentPassword,
      newPassword,
      confirmPassword
    );
    if (clientErr) {
      setFormError(clientErr);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/admin-change-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
        sessionsRevoked?: number;
      };
      if (!res.ok) {
        setFormError(String(data.error || "Password change failed"));
        return;
      }
      const n = Number(data.sessionsRevoked || 0);
      setFormOk(`Password changed. Other devices were signed out. ${n}`);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setFormError("Password change failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const confirmLogoutAll = async () => {
    setLogoutError("");
    setLogoutBusy(true);
    try {
      const res = await fetch("/api/admin-logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setLogoutError(String(data.error || "Logout failed"));
        setLogoutBusy(false);
        return;
      }
      clearLegacyAdminKeys();
      onLoggedOut();
    } catch {
      setLogoutError("Logout failed. Please try again.");
      setLogoutBusy(false);
    }
  };

  if (loadError) {
    return (
      <div role="alert" style={{ padding: 16, color: "#DC2626", fontSize: 14 }}>
        {loadError}
      </div>
    );
  }

  if (!info) {
    return <div style={{ padding: 16, color: "#666", fontSize: 14 }}>Loading…</div>;
  }

  const isMaster = Boolean(info.isMaster);

  return (
    <div style={{ maxWidth: 560 }}>
      <section aria-labelledby="account-security-identity" style={{ marginBottom: 28 }}>
        <h2
          id="account-security-identity"
          style={{ fontSize: 16, fontWeight: 700, marginBottom: 10, color: "#111" }}
        >
          Signed in
        </h2>
        <p style={{ fontSize: 14, color: "#333", marginBottom: 4 }}>
          <span style={{ color: "#666" }}>Name:</span> {info.name || "—"}
        </p>
        <p style={{ fontSize: 14, color: "#333" }}>
          <span style={{ color: "#666" }}>Role:</span> {info.role || "—"}
        </p>
      </section>

      <section aria-labelledby="account-security-password" style={{ marginBottom: 28 }}>
        <h2
          id="account-security-password"
          style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: "#111" }}
        >
          Password
        </h2>
        {isMaster ? (
          <div
            role="status"
            style={{
              padding: "12px 14px",
              background: "rgba(234,88,12,0.08)",
              border: "1px solid #EA580C",
              borderRadius: 10,
              fontSize: 13,
              color: "#9A3412",
              lineHeight: 1.45,
            }}
          >
            {MASTER_ACCOUNT_SECURITY_WARNING}
          </div>
        ) : (
          <form onSubmit={submitPassword} noValidate>
            <label style={labelStyle}>
              Current password
              <input
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                style={fieldStyle}
                disabled={busy}
              />
            </label>
            <label style={labelStyle}>
              New password
              <input
                type="password"
                name="newPassword"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                style={fieldStyle}
                disabled={busy}
              />
            </label>
            <label style={labelStyle}>
              Confirm new password
              <input
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                style={fieldStyle}
                disabled={busy}
              />
            </label>
            {formError ? (
              <p role="alert" style={{ color: "#DC2626", fontSize: 13, marginBottom: 12 }}>
                {formError}
              </p>
            ) : null}
            {formOk ? (
              <p role="status" style={{ color: "#16A34A", fontSize: 13, marginBottom: 12 }}>
                {formOk}
              </p>
            ) : null}
            <button type="submit" style={btnPrimary} disabled={busy}>
              {busy ? "Saving…" : "Change password"}
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="account-security-logout-all">
        <h2
          id="account-security-logout-all"
          style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: "#111" }}
        >
          Devices
        </h2>
        {!logoutConfirm ? (
          <button
            type="button"
            style={btnDanger}
            onClick={() => {
              setLogoutError("");
              setLogoutConfirm(true);
            }}
            disabled={logoutBusy}
          >
            Log out all devices
          </button>
        ) : (
          <div
            role="group"
            aria-label="Confirm log out all devices"
            style={{
              padding: "12px 14px",
              border: "1px solid #E5E5E5",
              borderRadius: 10,
              background: "#FAFAFA",
            }}
          >
            <p style={{ fontSize: 13, color: "#333", marginBottom: 12, lineHeight: 1.45 }}>
              This signs you out on every device, including this one. Continue?
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                style={btnDanger}
                onClick={() => void confirmLogoutAll()}
                disabled={logoutBusy}
              >
                {logoutBusy ? "Signing out…" : "Yes, log out everywhere"}
              </button>
              <button
                type="button"
                style={btnMuted}
                onClick={() => setLogoutConfirm(false)}
                disabled={logoutBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {logoutError ? (
          <p role="alert" style={{ color: "#DC2626", fontSize: 13, marginTop: 10 }}>
            {logoutError}
          </p>
        ) : null}
      </section>
    </div>
  );
}
