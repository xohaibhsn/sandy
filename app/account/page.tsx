"use client";

import { useState } from "react";
import Link from "next/link";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import AccountShell from "./AccountShell";
import { accountFetch, type AccountMe } from "./accountClient";

function Dashboard({ me }: { me: AccountMe }) {
  const [claimMsg, setClaimMsg] = useState("");
  const [claimError, setClaimError] = useState("");
  const [claiming, setClaiming] = useState(false);

  const claim = async () => {
    setClaiming(true);
    setClaimMsg("");
    setClaimError("");
    const r = await accountFetch<{ linked: number }>("/api/account/orders/claim", {
      method: "POST",
      body: {},
    });
    setClaiming(false);
    if (!r.ok) {
      setClaimError(r.error);
      return;
    }
    setClaimMsg(
      (r.data?.linked ?? 0) > 0
        ? CUSTOMER_TEXTS.ACCOUNT_CLAIM_ORDERS_DONE
        : CUSTOMER_TEXTS.ACCOUNT_CLAIM_ORDERS_NONE
    );
  };

  return (
    <>
      <div className="acc-card">
        <h3>{me.name || "Welcome"}</h3>
        <div className="acc-info-row">
          <span>{CUSTOMER_TEXTS.ACCOUNT_PHONE_LABEL}</span>
          <span>{me.phone_norm}</span>
        </div>
        {me.email ? (
          <div className="acc-info-row">
            <span>{CUSTOMER_TEXTS.ACCOUNT_PROFILE_EMAIL}</span>
            <span>{me.email}</span>
          </div>
        ) : null}
      </div>

      <div className="acc-link-grid" style={{ marginBottom: 16 }}>
        <Link className="acc-link-card" href="/account/orders">
          {CUSTOMER_TEXTS.ACCOUNT_ORDERS_TITLE}
        </Link>
        <Link className="acc-link-card" href="/account/addresses">
          {CUSTOMER_TEXTS.ACCOUNT_ADDRESSES_TITLE}
        </Link>
        <Link className="acc-link-card" href="/account/wishlist">
          {CUSTOMER_TEXTS.ACCOUNT_WISHLIST_TITLE}
        </Link>
        <Link className="acc-link-card" href="/account/profile">
          {CUSTOMER_TEXTS.ACCOUNT_PROFILE_TITLE}
        </Link>
      </div>

      <div className="acc-card">
        <button type="button" className="acc-btn ghost small" onClick={claim} disabled={claiming}>
          {CUSTOMER_TEXTS.ACCOUNT_CLAIM_ORDERS}
        </button>
        {claimMsg ? <p className="acc-ok">{claimMsg}</p> : null}
        {claimError ? <p className="acc-error">{claimError}</p> : null}
      </div>
    </>
  );
}

export default function AccountHomePage() {
  return (
    <AccountShell title={CUSTOMER_TEXTS.ACCOUNT_DASHBOARD_TITLE}>
      {(me) => <Dashboard me={me} />}
    </AccountShell>
  );
}
