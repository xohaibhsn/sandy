"use client";

import { useEffect, useState } from "react";
import { useSiteContent } from "@/hooks/useSiteContent";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";

/**
 * Product-page wishlist toggle. Renders nothing (zero DOM) unless the
 * accounts_enabled flag is "1" AND the visitor is signed in.
 */
export default function WishlistButton({ productId }: { productId: number }) {
  const sc = useSiteContent();
  const accountsOn = sc?.accounts_enabled === "1";
  const [signedIn, setSignedIn] = useState(false);
  const [inList, setInList] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accountsOn) return;
    let cancelled = false;
    (async () => {
      try {
        const me = await fetch("/api/account/me", { credentials: "include", cache: "no-store" });
        if (cancelled || !me.ok) return;
        setSignedIn(true);
        const wl = await fetch("/api/account/wishlist", { credentials: "include", cache: "no-store" });
        if (cancelled || !wl.ok) return;
        const data = await wl.json();
        const items: { product_id?: number }[] = Array.isArray(data?.items) ? data.items : [];
        setInList(items.some((i) => Number(i.product_id) === productId));
      } catch {
        /* stay hidden / unchanged */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountsOn, productId]);

  if (!accountsOn || !signedIn) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = inList
        ? await fetch(`/api/account/wishlist?productId=${productId}`, {
            method: "DELETE",
            credentials: "include",
          })
        : await fetch("/api/account/wishlist", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productId }),
          });
      if (res.ok) setInList(!inList);
    } catch {
      /* leave state unchanged */
    }
    setBusy(false);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={inList}
      style={{
        width: "100%",
        marginTop: 10,
        background: "transparent",
        color: "#111111",
        border: "1px solid #111111",
        padding: 16,
        borderRadius: 2,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        cursor: busy ? "wait" : "pointer",
        fontFamily: "var(--font-body)",
      }}
    >
      {inList ? "♥ " : "♡ "}
      {inList ? CUSTOMER_TEXTS.ACCOUNT_WISHLIST_REMOVE : CUSTOMER_TEXTS.ACCOUNT_WISHLIST_ADD}
    </button>
  );
}
