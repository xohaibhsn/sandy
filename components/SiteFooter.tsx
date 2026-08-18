"use client";

import { cmsText, useSiteContent } from "@/hooks/useSiteContent";
import { FOOTER_COPY, SITE_NAME, SITE_NAME_CAPS } from "@/lib/site";

export default function SiteFooter() {
  const sc = useSiteContent();
  const brand = cmsText(sc, "site_title", SITE_NAME).toUpperCase() || SITE_NAME_CAPS;
  const tagline = cmsText(sc, "footer_tagline", "");
  const copy = cmsText(sc, "footer_text", FOOTER_COPY);
  const ig = cmsText(sc, "social_instagram", "");
  const fb = cmsText(sc, "social_facebook", "");
  const tt = cmsText(sc, "social_tiktok", "");

  return (
    <>
      <style>{`
        .site-footer {
          background: #111111;
          padding: 50px 60px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 20px;
        }
        .site-footer-brand { display: flex; flex-direction: column; gap: 6px; }
        .site-footer-logo {
          font-family: var(--font-display), Georgia, serif;
          font-size: 17px;
          font-weight: 800;
          color: #FFFFFF;
          letter-spacing: 0.04em;
        }
        .site-footer-tag {
          font-size: 12px;
          color: rgba(255,255,255,0.45);
          max-width: 280px;
          line-height: 1.45;
        }
        .site-footer-links {
          display: flex;
          gap: 24px;
          list-style: none;
          margin: 0;
          padding: 0;
          flex-wrap: wrap;
        }
        .site-footer-links a {
          color: rgba(255,255,255,0.6);
          text-decoration: none;
          font-size: 13px;
        }
        .site-footer-links a:hover { color: #FFFFFF; }
        .site-footer-copy { font-size: 12px; color: rgba(255,255,255,0.4); }
        .site-footer-social { display: flex; gap: 14px; align-items: center; }
        .site-footer-social a { color: rgba(255,255,255,0.6); font-size: 13px; text-decoration: none; }
        .site-footer-social a:hover { color: #FFFFFF; }
        @media (max-width: 768px) {
          .site-footer {
            padding: 36px 24px;
            flex-direction: column;
            text-align: center;
          }
          .site-footer-tag { max-width: none; }
          .site-footer-links { justify-content: center; }
        }
      `}</style>
      <footer className="site-footer">
        <div className="site-footer-brand">
          <div className="site-footer-logo">{brand}</div>
          {tagline ? <div className="site-footer-tag">{tagline}</div> : null}
        </div>
        <ul className="site-footer-links">
          <li><a href="/privacy-policy">{cmsText(sc, "footer_privacy", "Privacy Policy")}</a></li>
          <li><a href="/terms">{cmsText(sc, "footer_terms", "Terms & Conditions")}</a></li>
          <li><a href="/refund-policy">{cmsText(sc, "footer_refund", "Refund Policy")}</a></li>
          <li><a href="/faq">{cmsText(sc, "footer_faq", "FAQ")}</a></li>
        </ul>
        {(ig || fb || tt) ? (
          <div className="site-footer-social">
            {ig ? <a href={ig} target="_blank" rel="noopener noreferrer">Instagram</a> : null}
            {fb ? <a href={fb} target="_blank" rel="noopener noreferrer">Facebook</a> : null}
            {tt ? <a href={tt} target="_blank" rel="noopener noreferrer">TikTok</a> : null}
          </div>
        ) : null}
        <div className="site-footer-copy">{copy}</div>
      </footer>
    </>
  );
}
