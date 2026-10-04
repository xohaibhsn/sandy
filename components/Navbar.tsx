"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cmsText, useSiteContent } from "@/hooks/useSiteContent";
import { SITE_NAME, SITE_NAME_CAPS } from "@/lib/site";

export interface NavbarProps {
  logoUrl?: string;
  cartCount?: number;
  /** cart = Cart CTA, shop = Shop Now, none = links only */
  cta?: "cart" | "shop" | "none";
  shopHref?: string;
  /** Extra content before the hamburger (e.g. products search) */
  children?: ReactNode;
}

export default function Navbar({
  logoUrl,
  cartCount = 0,
  cta = "cart",
  shopHref = "/products",
  children,
}: NavbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);
  const sc = useSiteContent();
  const [logo, setLogo] = useState(logoUrl || "");
  const [categories, setCategories] = useState<{ name: string; slug: string }[]>([]);
  const brand = cmsText(sc, "site_title", SITE_NAME).toUpperCase() || SITE_NAME_CAPS;

  useEffect(() => {
    fetch("/api/public-categories")
      .then((r) => {
        if (!r.ok) throw new Error("categories unavailable");
        return r.json();
      })
      .then((data) => {
        if (!Array.isArray(data)) {
          setCategories([]);
          return;
        }
        setCategories(
          data
            .filter((c: { name?: string; slug?: string }) => c?.name && c?.slug)
            .map((c: { name: string; slug: string }) => ({ name: c.name, slug: c.slug }))
        );
      })
      .catch(() => {
        setCategories([]);
      });
  }, []);

  useEffect(() => {
    if (logoUrl !== undefined) {
      setLogo(logoUrl || "");
      return;
    }
    const fromCms = cmsText(sc, "site_logo_url", "");
    if (fromCms) setLogo(fromCms);
  }, [logoUrl, sc]);

  const close = () => {
    setMenuOpen(false);
    setCatsOpen(false);
  };

  const logoEl = logo ? (
    <a href="/" className="nav-logo nav-logo-img">
      <img
        src={logo}
        alt={brand}
        style={{ height: 36, width: "auto", objectFit: "contain", display: "block" }}
      />
    </a>
  ) : (
    <a href="/" className="nav-logo nav-logo-text">
      {brand}
    </a>
  );

  return (
    <>
      <style>{`
        .site-nav {
          position: fixed; top: 0; left: 0; right: 0; z-index: 100;
          padding: 16px 48px; display: flex; align-items: center; justify-content: space-between;
          background: rgba(255,255,255,0.96); border-bottom: 1px solid #E8E4DF;
          box-shadow: none;
        }
        .site-nav .nav-logo {
          display: flex; align-items: center; flex-shrink: 0;
          text-decoration: none; color: #111111;
        }
        .site-nav .nav-logo-text {
          font-family: var(--font-logo), 'Cinzel', Georgia, serif;
          font-size: 20px; font-weight: 900; letter-spacing: 2px;
          color: #111111; text-decoration: none;
        }
        .site-nav .nav-links {
          display: flex; gap: 36px; list-style: none; margin: 0; padding: 0;
          align-items: center;
        }
        .site-nav .nav-links a {
          font-family: var(--font-body), 'Inter', system-ui, sans-serif;
          color: #3F3A36; text-decoration: none; font-size: 12px; font-weight: 500;
          letter-spacing: 0.12em; text-transform: uppercase; transition: opacity 0.2s;
        }
        .site-nav .nav-links a:hover { color: #111111; opacity: 0.7; }
        .site-nav .nav-cta {
          background: #111111 !important; color: #FFFFFF !important;
          padding: 9px 18px !important; border-radius: 2px !important; font-weight: 600 !important;
          font-family: var(--font-body), 'Inter', system-ui, sans-serif !important;
          letter-spacing: 0.08em !important; font-size: 11px !important; text-transform: uppercase !important;
        }
        .site-nav .nav-cta:hover { background: #333333 !important; }
        .site-nav .hamburger {
          display: none; flex-direction: column; gap: 5px; cursor: pointer;
          background: none; border: none; padding: 5px; z-index: 101;
        }
        .site-nav .hamburger span {
          display: block; width: 25px; height: 2px; background: #111111; border-radius: 2px;
        }
        .site-nav .nav-end { display: flex; align-items: center; gap: 12px; }
        .site-nav .nav-cats { position: relative; }
        .site-nav .nav-cats-trigger {
          font-family: var(--font-body), 'Inter', system-ui, sans-serif;
          color: #3F3A36; background: none; border: none; padding: 0; cursor: pointer;
          font-size: 12px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase;
        }
        .site-nav .nav-cats-trigger:hover { color: #111111; opacity: 0.7; }
        .site-nav .nav-cats-panel {
          display: none; position: absolute; top: calc(100% + 14px); left: 0;
          min-width: 200px; background: #FFFFFF; border: 1px solid #E8E4DF;
          box-shadow: 0 8px 24px rgba(0,0,0,0.08); padding: 10px 0; z-index: 120;
        }
        .site-nav .nav-cats.open .nav-cats-panel { display: block; }
        .site-nav .nav-cats-panel a {
          display: block; padding: 10px 16px; letter-spacing: 0.08em; text-transform: none;
          font-size: 13px; color: #3F3A36; text-decoration: none;
        }
        .site-nav .nav-cats-panel a:hover { background: #F7F5F2; color: #111111; }
        .site-nav .nav-cats-mobile { display: none; flex-direction: column; gap: 14px; align-items: center; }
        @media (max-width: 768px) {
          .site-nav { padding: 16px 24px; }
          .site-nav .nav-links { display: none; }
          .site-nav .nav-links.open {
            display: flex; flex-direction: column; position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh; background: #FFFFFF;
            align-items: center; justify-content: center; gap: 28px; z-index: 9999;
            margin: 0; padding: 0; overflow-y: auto;
          }
          .site-nav .nav-links.open a, .site-nav .nav-links.open .nav-cats-trigger { color: #111111; font-size: 18px; }
          .site-nav .hamburger { display: flex; }
          .site-nav .nav-cats-panel {
            position: static; display: none; box-shadow: none; border: none;
            background: transparent; min-width: 0; padding: 0;
          }
          .site-nav .nav-cats.open .nav-cats-panel { display: flex; flex-direction: column; gap: 14px; align-items: center; margin-top: 8px; }
          .site-nav .nav-cats-panel a { padding: 0; font-size: 16px; }
        }
      `}</style>

      <nav className="site-nav">
        {logoEl}
        <ul className={`nav-links ${menuOpen ? "open" : ""}`}>
          <li><a href="/" onClick={close}>{cmsText(sc, "nav_home", "Home")}</a></li>
          <li><a href="/products" onClick={close}>{cmsText(sc, "nav_products", "Products")}</a></li>
          {categories.length > 0 && (
            <li
              className={`nav-cats ${catsOpen ? "open" : ""}`}
              onMouseEnter={() => setCatsOpen(true)}
              onMouseLeave={() => setCatsOpen(false)}
            >
              <button
                type="button"
                className="nav-cats-trigger"
                aria-expanded={catsOpen}
                aria-haspopup="true"
                onClick={() => setCatsOpen((v) => !v)}
              >
                Categories
              </button>
              <div className="nav-cats-panel" role="menu">
                {categories.map((c) => (
                  <a key={c.slug} href={`/category/${c.slug}`} onClick={close} role="menuitem">
                    {c.name}
                  </a>
                ))}
              </div>
            </li>
          )}
          <li><a href="/order-tracking" onClick={close}>{cmsText(sc, "nav_track", "Track Order")}</a></li>
          <li><a href="/blog" onClick={close}>{cmsText(sc, "nav_blog", "Blog")}</a></li>
          <li><a href="/contact" onClick={close}>{cmsText(sc, "nav_contact", "Contact")}</a></li>
          {cta === "cart" && (
            <li>
              <a href="/cart" className="nav-cta" onClick={close}>
                {cmsText(sc, "nav_cart_label", "Cart")}{cartCount > 0 ? ` (${cartCount})` : ""}
              </a>
            </li>
          )}
          {cta === "shop" && (
            <li>
              <a href={shopHref} className="nav-cta" onClick={close}>
                {cmsText(sc, "nav_shop_label", "Shop Now")}
              </a>
            </li>
          )}
        </ul>
        <div className="nav-end">
          {children}
          <button
            className="hamburger"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Menu"
            type="button"
          >
            <span /><span /><span />
          </button>
        </div>
      </nav>
    </>
  );
}
