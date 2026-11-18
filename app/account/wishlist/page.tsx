"use client";

import { useEffect, useState } from "react";
import { useCart } from "../../lib/cartContext";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import { formatPrice } from "@/lib/site";
import AccountShell from "../AccountShell";
import { accountFetch } from "../accountClient";

type WishItem = {
  product_id: number;
  name: string;
  price: number | string;
  slug: string | null;
  image: string | null;
};

function WishlistView() {
  const { addToCart, cart } = useCart();
  const [items, setItems] = useState<WishItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    accountFetch<{ items: WishItem[] }>("/api/account/wishlist").then((r) => {
      if (cancelled) return;
      if (r.ok) setItems(r.data?.items ?? []);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (productId: number) => {
    setError("");
    const r = await accountFetch(`/api/account/wishlist?productId=${productId}`, { method: "DELETE" });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setItems((prev) => (prev || []).filter((i) => i.product_id !== productId));
  };

  if (items === null && !error) return <div className="acc-center">Loading…</div>;

  return (
    <>
      {error ? <p className="acc-error" role="alert" style={{ marginBottom: 12 }}>{error}</p> : null}
      {items && items.length === 0 ? (
        <div className="acc-center">{CUSTOMER_TEXTS.ACCOUNT_WISHLIST_EMPTY}</div>
      ) : null}
      {(items ?? []).map((item) => {
        const inCart = cart.some((c) => c.id === item.product_id);
        return (
          <div className="acc-card" key={item.product_id}>
            <div className="acc-list-row">
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                {item.image ? (
                  // Product thumbnails may be absolute CDN URLs; match storefront <img> usage.
                  // eslint-disable-next-line @next/next/no-img-element -- external product images
                  <img
                    src={item.image}
                    alt={item.name}
                    style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, background: "#F7F5F2" }}
                  />
                ) : null}
                <div>
                  {item.slug ? (
                    <a className="acc-order-id" href={`/products/${item.slug}`}>{item.name}</a>
                  ) : (
                    <span className="acc-order-id">{item.name}</span>
                  )}
                  <p className="acc-price">{formatPrice(item.price)}</p>
                </div>
              </div>
              <div className="acc-actions" style={{ marginTop: 0 }}>
                <button
                  type="button"
                  className="acc-btn small"
                  disabled={inCart}
                  onClick={() =>
                    addToCart({
                      id: item.product_id,
                      name: item.name,
                      price: Number(item.price),
                      qty: 1,
                      image: item.image || undefined,
                    })
                  }
                >
                  {inCart ? "In cart" : CUSTOMER_TEXTS.ACCOUNT_WISHLIST_ADD_CART}
                </button>
                <button type="button" className="acc-btn small ghost" onClick={() => remove(item.product_id)}>
                  {CUSTOMER_TEXTS.ACCOUNT_WISHLIST_REMOVE}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function AccountWishlistPage() {
  return (
    <AccountShell title={CUSTOMER_TEXTS.ACCOUNT_WISHLIST_TITLE}>
      <WishlistView />
    </AccountShell>
  );
}
