"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import { useCart } from "../../lib/cartContext";
import { formatPrice } from "@/lib/site";

type Category = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
};

type Product = {
  id: number;
  name: string;
  slug?: string | null;
  price: number;
  image: string | null;
  category: string;
  short_description?: string | null;
  description?: string | null;
  badge?: string | null;
};

function productHref(p: Product): string {
  return `/products/${p.slug || p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export default function CategoryClient({
  category,
  initialProducts,
}: {
  category: Category;
  initialProducts: Product[];
}) {
  const products = initialProducts;
  const { addToCart, cart } = useCart();
  const [added, setAdded] = useState<number | null>(null);

  return (
    <>
      <style>{`
        .cat-page { padding-top: 100px; min-height: 100vh; background: #FFFFFF; }
        .cat-header { max-width: 1200px; margin: 0 auto; padding: 40px 48px 24px; }
        .cat-tag { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #6B6560; margin-bottom: 8px; }
        .cat-title { font-family: var(--font-display), Georgia, serif; font-size: clamp(1.6rem, 3vw, 2.4rem); font-weight: 800; color: #111; margin: 0 0 10px; }
        .cat-desc { color: #555; font-size: 15px; max-width: 640px; line-height: 1.6; }
        .cat-grid { max-width: 1200px; margin: 0 auto; padding: 12px 48px 80px; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 22px; }
        .product-card { background:#FFFFFF; border:none; border-radius:0; overflow:hidden; transition:opacity 0.3s; position:relative; box-shadow:none; min-width:0; cursor:pointer; }
        .product-card:hover { opacity:0.88; }
        .product-image { width:100%; aspect-ratio:1/1; background:#F7F5F2; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; }
        .product-image img { width:100%; height:100%; object-fit:cover; }
        .product-badge { position:absolute; top:12px; left:12px; background:#111; color:#fff; font-size:10px; letter-spacing:0.1em; text-transform:uppercase; padding:4px 8px; }
        .product-info { padding: 14px 4px 8px; }
        .product-name { font-weight:700; font-size:15px; color:#111; margin-bottom:6px; }
        .product-short { font-size:13px; color:#666; line-height:1.5; margin-bottom:10px; }
        .product-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .product-price { color:#111; font-weight:700; font-size:14px; }
        .add-btn { background:#111; color:#fff; border:none; padding:8px 12px; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; cursor:pointer; }
        .cat-empty { grid-column: 1 / -1; color: #666; padding: 40px 0; font-size: 15px; line-height: 1.6; }
        @media (max-width: 768px) {
          .cat-header, .cat-grid { padding-left: 24px; padding-right: 24px; }
        }
      `}</style>
      <Navbar cartCount={cart.length} cta="cart" />
      <div className="cat-page">
        <div className="cat-header">
          <div className="cat-tag">Shop</div>
          <h1 className="cat-title">{category.name}</h1>
          {category.description ? (
            <p className="cat-desc">{category.description}</p>
          ) : null}
        </div>
        <div className="cat-grid">
          {products.length === 0 ? (
            <div className="cat-empty">
              No products are currently available in this category.
            </div>
          ) : (
            products.map((p) => (
              <div
                className="product-card"
                key={p.id}
                onClick={() => {
                  window.location.href = productHref(p);
                }}
              >
                <div className="product-image">
                  {p.badge ? <div className="product-badge">{p.badge}</div> : null}
                  {p.image ? (
                    <img src={p.image} alt={p.name} />
                  ) : (
                    <div style={{ fontSize: 48, color: "#CCC" }}>📦</div>
                  )}
                </div>
                <div className="product-info">
                  <div className="product-name">{p.name}</div>
                  {p.short_description ? (
                    <div className="product-short">{p.short_description}</div>
                  ) : null}
                  <div className="product-footer">
                    <div className="product-price">{formatPrice(p.price)}</div>
                    <button
                      type="button"
                      className="add-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        addToCart({
                          id: p.id,
                          name: p.name,
                          price: Number(p.price),
                          qty: 1,
                        });
                        setAdded(p.id);
                        setTimeout(() => setAdded(null), 1200);
                      }}
                    >
                      {added === p.id ? "Added" : "Add to cart"}
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <SiteFooter />
    </>
  );
}
