"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import { otpCodeSentText } from "@/lib/otp/messages";
import AccountShell from "../AccountShell";
import { accountFetch } from "../accountClient";

const COOLDOWN_SECONDS = 60;

export default function AccountLoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [channel, setChannel] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Already signed in: go straight to the dashboard.
  useEffect(() => {
    let cancelled = false;
    accountFetch("/api/account/me").then((r) => {
      if (!cancelled && r.ok) router.replace("/account");
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCode = async () => {
    const trimmed = phone.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    const r = await accountFetch<{ challengeId: string; channel?: string }>("/api/account/login-start", {
      method: "POST",
      body: { phone: trimmed },
    });
    setBusy(false);
    if (r.ok && r.data?.challengeId) {
      setChallengeId(r.data.challengeId);
      setChannel(r.data.channel === "whatsapp" ? "whatsapp" : "sms");
      setCode("");
      setCooldown(COOLDOWN_SECONDS);
    } else {
      setError(r.error);
    }
  };

  const verify = async () => {
    const digits = code.trim();
    if (!challengeId || digits.length !== 6 || busy) return;
    setBusy(true);
    setError("");
    const r = await accountFetch("/api/account/login-verify", {
      method: "POST",
      body: { challengeId, code: digits },
    });
    if (r.ok) {
      router.push("/account");
      return;
    }
    setBusy(false);
    setError(r.error);
  };

  const otpStage = Boolean(challengeId);

  return (
    <AccountShell
      auth={false}
      title={CUSTOMER_TEXTS.ACCOUNT_LOGIN_TITLE}
      sub={CUSTOMER_TEXTS.ACCOUNT_LOGIN_SUB}
    >
      <div className="acc-card">
        {!otpStage ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
          >
            <div className="acc-field">
              <label className="acc-label" htmlFor="acc-phone">
                {CUSTOMER_TEXTS.ACCOUNT_PHONE_LABEL}
              </label>
              <input
                id="acc-phone"
                className="acc-input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="03XX XXXXXXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <button className="acc-btn block" type="submit" disabled={busy || !phone.trim()}>
              {CUSTOMER_TEXTS.ACCOUNT_OTP_SEND}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
          >
            <p data-otp-sent={channel || "sms"} style={{ marginBottom: 12, fontSize: 14, lineHeight: 1.5, color: "#333" }}>
              {otpCodeSentText(channel || "sms", phone)}
            </p>
            <div className="acc-field">
              <label className="acc-label" htmlFor="acc-code">
                {CUSTOMER_TEXTS.ACCOUNT_OTP_ENTER}
              </label>
              <input
                id="acc-code"
                className="acc-input acc-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="••••••"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                autoFocus
              />
            </div>
            <button className="acc-btn block" type="submit" disabled={busy || code.length !== 6}>
              {CUSTOMER_TEXTS.ACCOUNT_OTP_VERIFY}
            </button>
            <div className="acc-actions" style={{ justifyContent: "center" }}>
              <button
                type="button"
                className="acc-btn small ghost"
                onClick={sendCode}
                disabled={busy || cooldown > 0}
              >
                {CUSTOMER_TEXTS.ACCOUNT_OTP_RESEND}
                {cooldown > 0 ? ` (${cooldown}s)` : ""}
              </button>
            </div>
          </form>
        )}
        {error ? (
          <p className="acc-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </AccountShell>
  );
}
