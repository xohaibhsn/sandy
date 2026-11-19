"use client";

import { useEffect, useState } from "react";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import { otpCodeSentText } from "@/lib/otp/messages";

const RESEND_COOLDOWN_SEC = 60;

type Props = {
  phone: string;
  /** Called with the verification token once the code is accepted. */
  onVerified: (verificationToken: string) => void;
  disabled?: boolean;
};

async function postJson(url: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} as Record<string, unknown> };
  }
}

/**
 * COD phone confirmation: send a code, enter the 6 digits, verify.
 * The parent should mount this with key={phone} so a changed phone number resets the step.
 */
export default function CodOtpStep({ phone, onVerified, disabled }: Props) {
  const [challengeId, setChallengeId] = useState("");
  const [channel, setChannel] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCode = async () => {
    if (sending || cooldown > 0 || !phone.trim()) return;
    setSending(true);
    setError("");
    const r = await postJson("/api/checkout/otp-start", { phone });
    setSending(false);
    const id = typeof r.data.challengeId === "string" ? r.data.challengeId : "";
    if (!r.ok || !id) {
      setError(
        typeof r.data.error === "string" && r.data.error.trim()
          ? r.data.error
          : CUSTOMER_TEXTS.COD_OTP_SEND_FAILED
      );
      return;
    }
    setChallengeId(id);
    setChannel(r.data.channel === "whatsapp" ? "whatsapp" : "sms");
    setCode("");
    setCooldown(RESEND_COOLDOWN_SEC);
  };

  const verify = async () => {
    if (verifying || !challengeId || !/^\d{6}$/.test(code)) return;
    setVerifying(true);
    setError("");
    const r = await postJson("/api/checkout/otp-verify", { challengeId, code });
    setVerifying(false);
    const token = typeof r.data.verificationToken === "string" ? r.data.verificationToken : "";
    if (!r.ok || !token) {
      setError(
        typeof r.data.error === "string" && r.data.error.trim()
          ? r.data.error
          : CUSTOMER_TEXTS.COD_OTP_INVALID
      );
      return;
    }
    setVerified(true);
    onVerified(token);
  };

  const btnStyle: React.CSSProperties = {
    padding: "10px 18px",
    borderRadius: 10,
    border: "1px solid #5B21B6",
    background: "#5B21B6",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  };

  if (verified) {
    return (
      <div className="bank-details" data-cod-otp="verified">
        <div style={{ fontSize: 14, fontWeight: 600, color: "#15803D" }}>
          ✅ {CUSTOMER_TEXTS.COD_OTP_VERIFIED}
        </div>
      </div>
    );
  }

  return (
    <div className="bank-details" data-cod-otp="pending">
      <p style={{ fontSize: 13, color: "#555", lineHeight: 1.6, marginBottom: 12 }}>
        {CUSTOMER_TEXTS.COD_OTP_REQUIRED}
      </p>

      <button
        type="button"
        style={{ ...btnStyle, opacity: sending || cooldown > 0 || disabled ? 0.6 : 1 }}
        disabled={sending || cooldown > 0 || disabled || !phone.trim()}
        onClick={() => { void sendCode(); }}
      >
        {challengeId ? CUSTOMER_TEXTS.COD_OTP_RESEND : CUSTOMER_TEXTS.COD_OTP_SEND}
        {cooldown > 0 ? ` (${cooldown}s)` : ""}
      </button>

      {challengeId && (
        <div className="form-group" style={{ marginTop: 14 }}>
          <p data-otp-sent={channel || "sms"} style={{ fontSize: 13, color: "#333", lineHeight: 1.5, marginBottom: 8 }}>
            {otpCodeSentText(channel || "sms", phone)}
          </p>
          <label>{CUSTOMER_TEXTS.COD_OTP_ENTER}</label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              style={{ maxWidth: 160, letterSpacing: 4 }}
            />
            <button
              type="button"
              style={{ ...btnStyle, opacity: verifying || code.length !== 6 || disabled ? 0.6 : 1 }}
              disabled={verifying || code.length !== 6 || disabled}
              onClick={() => { void verify(); }}
            >
              {CUSTOMER_TEXTS.COD_OTP_VERIFY}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: "#DC2626", marginTop: 10 }} role="alert">
          ⚠️ {error}
        </div>
      )}
    </div>
  );
}
