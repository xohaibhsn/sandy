"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import AccountShell from "../AccountShell";
import { accountFetch, type AccountMe } from "../accountClient";

function ProfileForm({ me }: { me: AccountMe }) {
  const router = useRouter();
  const [name, setName] = useState(me.name || "");
  const [email, setEmail] = useState(me.email || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    const r = await accountFetch("/api/account/profile", {
      method: "PATCH",
      body: { name: name.trim(), email: email.trim() },
    });
    setSaving(false);
    if (r.ok) setSaved(true);
    else setError(r.error);
  };

  const deleteAccount = async () => {
    if (confirm !== "DELETE") return;
    setDeleting(true);
    setDeleteError("");
    const r = await accountFetch("/api/account/delete", {
      method: "POST",
      body: { confirm: "DELETE" },
    });
    if (r.ok) {
      router.push("/");
      return;
    }
    setDeleting(false);
    setDeleteError(r.error);
  };

  return (
    <>
      <form
        className="acc-card"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <h3>{CUSTOMER_TEXTS.ACCOUNT_PROFILE_TITLE}</h3>
        <div className="acc-field">
          <label className="acc-label" htmlFor="prof-name">{CUSTOMER_TEXTS.ACCOUNT_PROFILE_NAME}</label>
          <input
            id="prof-name"
            className="acc-input"
            value={name}
            maxLength={255}
            autoComplete="name"
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        <div className="acc-field">
          <label className="acc-label" htmlFor="prof-email">{CUSTOMER_TEXTS.ACCOUNT_PROFILE_EMAIL}</label>
          <input
            id="prof-email"
            className="acc-input"
            type="email"
            value={email}
            autoComplete="email"
            onChange={(e) => {
              setEmail(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        <div className="acc-field">
          <span className="acc-label">{CUSTOMER_TEXTS.ACCOUNT_PHONE_LABEL}</span>
          <p className="acc-muted">{me.phone_norm}</p>
        </div>
        <button type="submit" className="acc-btn" disabled={saving}>
          {CUSTOMER_TEXTS.ACCOUNT_PROFILE_SAVE}
        </button>
        {saved ? <p className="acc-ok">{CUSTOMER_TEXTS.ACCOUNT_PROFILE_SAVED}</p> : null}
        {error ? <p className="acc-error" role="alert">{error}</p> : null}
      </form>

      <div className="acc-card" style={{ borderColor: "#FECACA" }}>
        <h3 style={{ color: "#DC2626" }}>{CUSTOMER_TEXTS.ACCOUNT_DELETE_TITLE}</h3>
        <p className="acc-muted" style={{ marginBottom: 14 }}>{CUSTOMER_TEXTS.ACCOUNT_DELETE_WARN}</p>
        <div className="acc-field">
          <label className="acc-label" htmlFor="prof-delete">{CUSTOMER_TEXTS.ACCOUNT_DELETE_CONFIRM}</label>
          <input
            id="prof-delete"
            className="acc-input"
            value={confirm}
            autoComplete="off"
            placeholder="DELETE"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="acc-btn danger"
          disabled={deleting || confirm !== "DELETE"}
          onClick={deleteAccount}
        >
          {CUSTOMER_TEXTS.ACCOUNT_DELETE_SUBMIT}
        </button>
        {deleteError ? <p className="acc-error" role="alert">{deleteError}</p> : null}
      </div>
    </>
  );
}

export default function AccountProfilePage() {
  return (
    <AccountShell title={CUSTOMER_TEXTS.ACCOUNT_PROFILE_TITLE}>
      {(me) => <ProfileForm me={me} />}
    </AccountShell>
  );
}
