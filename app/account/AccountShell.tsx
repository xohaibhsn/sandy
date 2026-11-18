"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import { accountFetch, type AccountMe } from "./accountClient";

export const accountStyles = `
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body { background:#FFFFFF; color:#111111; font-family:var(--font-body); overflow-x:hidden; }
  .acc-wrapper { position:relative; z-index:1; padding-top:100px; min-height:100vh; background:#FFFFFF; }
  .acc-header { max-width:800px; margin:0 auto; padding:40px 24px 20px; text-align:center; }
  .acc-tag { font-size:12px; letter-spacing:4px; text-transform:uppercase; color:#5B21B6; margin-bottom:12px; }
  .acc-title { font-family:var(--font-display); font-size:clamp(1.8rem,3vw,2.5rem); font-weight:800; letter-spacing:-0.03em; color:#111111; margin-bottom:10px; }
  .acc-sub { color:#555555; font-size:15px; line-height:1.7; }
  .acc-tabs { max-width:760px; margin:0 auto; padding:0 24px; display:flex; flex-wrap:wrap; gap:8px; justify-content:center; align-items:center; }
  .acc-tab { padding:9px 18px; border-radius:30px; border:1px solid #E5E5E5; color:#111111; text-decoration:none; font-size:12px; font-weight:600; letter-spacing:1px; text-transform:uppercase; background:#FFFFFF; cursor:pointer; font-family:var(--font-body); }
  .acc-tab:hover { border-color:#5B21B6; color:#5B21B6; }
  .acc-tab.active { background:#5B21B6; border-color:#5B21B6; color:#FFFFFF; }
  .acc-content { max-width:700px; margin:32px auto 80px; padding:0 24px; }
  .acc-card { background:#FFFFFF; border:1px solid #E5E5E5; border-radius:16px; padding:24px 28px; box-shadow:0 2px 12px rgba(0,0,0,0.08); margin-bottom:16px; }
  .acc-card h3 { font-family:var(--font-display); font-size:16px; font-weight:700; margin-bottom:12px; color:#111111; }
  .acc-muted { color:#666666; font-size:14px; line-height:1.6; }
  .acc-center { text-align:center; padding:48px 0; color:#666666; font-size:15px; }
  .acc-link-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:12px; }
  .acc-link-card { display:block; background:#F9F7FF; border:1px solid #E5E5E5; border-radius:12px; padding:20px; text-decoration:none; color:#111111; font-family:var(--font-display); font-weight:700; font-size:15px; transition:all 0.2s; }
  .acc-link-card:hover { border-color:#5B21B6; color:#5B21B6; transform:translateY(-1px); }
  .acc-label { display:block; font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#666666; margin-bottom:6px; font-weight:600; }
  .acc-input { width:100%; background:#FFFFFF; border:1px solid #E5E5E5; border-radius:12px; padding:13px 16px; color:#111111; font-family:var(--font-body); font-size:15px; outline:none; transition:all 0.2s; }
  .acc-input::placeholder { color:#999999; }
  .acc-input:focus { border-color:#5B21B6; box-shadow:0 0 0 3px rgba(91,33,182,0.1); }
  .acc-field { margin-bottom:14px; }
  .acc-row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .acc-btn { background:#5B21B6; color:#FFFFFF; border:none; padding:13px 28px; border-radius:50px; font-size:14px; font-weight:600; cursor:pointer; transition:all 0.2s; white-space:nowrap; font-family:var(--font-body); }
  .acc-btn:hover { background:#4C1D95; transform:translateY(-1px); }
  .acc-btn:disabled { background:#A78BCA; cursor:not-allowed; transform:none; }
  .acc-btn.small { padding:8px 16px; font-size:12px; }
  .acc-btn.ghost { background:#FFFFFF; color:#5B21B6; border:1px solid #5B21B6; }
  .acc-btn.ghost:hover { background:#F9F7FF; }
  .acc-btn.danger { background:#DC2626; }
  .acc-btn.danger:hover { background:#B91C1C; }
  .acc-btn.danger:disabled { background:#F3A5A5; }
  .acc-btn.block { width:100%; }
  .acc-error { color:#DC2626; font-size:14px; margin-top:12px; line-height:1.5; }
  .acc-ok { color:#166534; font-size:14px; margin-top:12px; line-height:1.5; }
  .acc-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
  .acc-badge { padding:6px 14px; border-radius:30px; font-size:11px; font-weight:700; letter-spacing:1px; text-transform:uppercase; display:inline-block; }
  .acc-badge.pending { background:#FEF3C7; border:1px solid rgba(234,179,8,0.3); color:#92400E; }
  .acc-badge.confirmed { background:#EDE9FE; border:1px solid rgba(91,33,182,0.3); color:#5B21B6; }
  .acc-badge.dispatched { background:#DBEAFE; border:1px solid rgba(37,99,235,0.3); color:#1E3A8A; }
  .acc-badge.delivered { background:#DCFCE7; border:1px solid rgba(22,163,74,0.3); color:#166534; }
  .acc-badge.cancelled { background:#FEE2E2; border:1px solid rgba(220,38,38,0.3); color:#DC2626; }
  .acc-badge.default { background:#EDE9FE; border:1px solid rgba(91,33,182,0.3); color:#5B21B6; margin-left:8px; }
  .acc-list-row { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  .acc-order-id { font-family:var(--font-display); font-size:17px; font-weight:700; color:#111111; text-decoration:none; }
  .acc-order-id:hover { color:#5B21B6; }
  .acc-price { color:#5B21B6; font-weight:700; font-family:var(--font-display); }
  .acc-item-row { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #F0F0F0; font-size:14px; }
  .acc-item-row:last-child { border:none; }
  .acc-total-row { display:flex; justify-content:space-between; padding:14px 0 0; border-top:2px solid #E5E5E5; margin-top:6px; font-family:var(--font-display); font-weight:700; font-size:16px; }
  .acc-total-row span:last-child { color:#5B21B6; font-size:20px; }
  .acc-steps { display:flex; flex-direction:column; }
  .acc-step { display:flex; gap:16px; }
  .acc-step-left { display:flex; flex-direction:column; align-items:center; width:32px; flex-shrink:0; }
  .acc-dot { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:14px; }
  .acc-dot.done { background:#5B21B6; }
  .acc-dot.active { background:#F59E0B; }
  .acc-dot.inactive { background:#F5F5F5; border:2px solid #E5E5E5; }
  .acc-line { width:2px; flex:1; min-height:20px; background:#E5E5E5; margin:2px 0; }
  .acc-line.done { background:#5B21B6; }
  .acc-step-content { padding:4px 0 22px; flex:1; }
  .acc-step-title { font-size:15px; font-weight:600; color:#111111; margin-bottom:4px; }
  .acc-step-title.inactive { color:#AAAAAA; }
  .acc-step-desc { font-size:13px; color:#666666; line-height:1.5; }
  .acc-info-row { display:flex; justify-content:space-between; gap:16px; padding:7px 0; border-bottom:1px solid #F0F0F0; font-size:13px; }
  .acc-info-row:last-child { border:none; }
  .acc-info-row span:first-child { color:#666666; }
  .acc-info-row span:last-child { color:#111111; font-weight:500; text-align:right; }
  .acc-otp { letter-spacing:8px; text-align:center; font-size:22px; font-family:var(--font-display); }
  @media(max-width:600px){
    .acc-wrapper { padding-top:84px; }
    .acc-link-grid, .acc-row2 { grid-template-columns:1fr; }
    .acc-card { padding:20px; }
  }
`;

const TABS: { href: string; label: string; match: (p: string) => boolean }[] = [
  { href: "/account", label: "Overview", match: (p) => p === "/account" },
  { href: "/account/orders", label: "Orders", match: (p) => p.startsWith("/account/orders") },
  { href: "/account/addresses", label: "Addresses", match: (p) => p.startsWith("/account/addresses") },
  { href: "/account/wishlist", label: "Wishlist", match: (p) => p.startsWith("/account/wishlist") },
  { href: "/account/profile", label: "Profile", match: (p) => p.startsWith("/account/profile") },
];

type ShellState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "authed"; me: AccountMe };

/**
 * Shared frame for /account/* pages: Navbar, header, section tabs, footer.
 * With auth (default) it loads /api/account/me, redirects to /account/login on 401,
 * and renders children only once signed in. Pass auth={false} for the login page.
 */
export default function AccountShell({
  title,
  sub,
  tag = "Account",
  auth = true,
  children,
}: {
  title: string;
  sub?: string;
  tag?: string;
  auth?: boolean;
  children: ReactNode | ((me: AccountMe) => ReactNode);
}) {
  const router = useRouter();
  const [state, setState] = useState<ShellState>({ status: "loading" });
  const rawPath = usePathname() || "";
  const pathname = rawPath.replace(/\/+$/, "") || "/";
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    accountFetch<{ customer: AccountMe }>("/api/account/me").then((r) => {
      if (cancelled) return;
      if (r.ok && r.data?.customer) {
        setState({ status: "authed", me: r.data.customer });
      } else if (r.status === 401) {
        router.replace("/account/login");
      } else {
        setState({ status: "error" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [auth, router]);

  const logout = async () => {
    setSigningOut(true);
    await accountFetch("/api/account/logout", { method: "POST", body: {} });
    router.push("/account/login");
  };

  let body: ReactNode;
  if (!auth) {
    body = typeof children === "function" ? null : children;
  } else if (state.status === "authed") {
    body = typeof children === "function" ? children(state.me) : children;
  } else if (state.status === "error") {
    body = (
      <div className="acc-center">
        <p>{CUSTOMER_TEXTS.ACCOUNT_GENERIC_ERROR}</p>
        <p style={{ marginTop: 12 }}>
          <Link href="/account/login" style={{ color: "#5B21B6" }}>
            {CUSTOMER_TEXTS.NAV_LOGIN}
          </Link>
        </p>
      </div>
    );
  } else {
    body = <div className="acc-center">Loading…</div>;
  }

  return (
    <>
      <style>{accountStyles}</style>
      <Navbar cta="shop" shopHref="/" />
      <div className="acc-wrapper">
        <div className="acc-header">
          <div className="acc-tag">✦ {tag}</div>
          <h1 className="acc-title">{title}</h1>
          {sub ? <p className="acc-sub">{sub}</p> : null}
        </div>

        {auth && state.status === "authed" ? (
          <nav className="acc-tabs" aria-label="Account">
            {TABS.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className={`acc-tab${t.match(pathname) ? " active" : ""}`}
              >
                {t.label}
              </Link>
            ))}
            <button type="button" className="acc-tab" onClick={logout} disabled={signingOut}>
              {CUSTOMER_TEXTS.ACCOUNT_LOGOUT}
            </button>
          </nav>
        ) : null}

        <div className="acc-content">{body}</div>
        <SiteFooter />
      </div>
    </>
  );
}
