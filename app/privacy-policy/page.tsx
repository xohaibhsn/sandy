"use client";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import { useContactConfig } from "@/hooks/useContactConfig";
import { cmsText, useSiteContent } from "@/hooks/useSiteContent";
import { LEGAL_DEFAULT_HTML, renderLegalBody } from "@/lib/legalContent";

const styles = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body { background:#FFFFFF; color:#111111; font-family:var(--font-body); overflow-x:hidden; }


  nav { position:fixed; top:0; left:0; right:0; z-index:100; padding:18px 60px;
    display:flex; align-items:center; justify-content:space-between;
    background:#FFFFFF; border-bottom:1px solid #E5E5E5; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
  .nav-logo { font-family:var(--font-logo); font-size:20px; font-weight:800; color:#111111; text-decoration:none; letter-spacing:2px; }
  .nav-links { display:flex; gap:36px; list-style:none; }
  .nav-links a { color:#111111; text-decoration:none; font-size:13px; font-weight:500; letter-spacing:1.5px; text-transform:uppercase; transition:color 0.3s; }
  .nav-links a:hover { color:#5B21B6; }
  .nav-cta { background:#5B21B6 !important; color:white !important; padding:10px 24px !important; border-radius:30px !important; font-weight:600 !important; }
  .hamburger { display:none; flex-direction:column; gap:5px; cursor:pointer; background:none; border:none; padding:5px; z-index:101; }
  .hamburger span { display:block; width:25px; height:2px; background:#111111; }
  @media(max-width:768px){
    nav{padding:16px 24px;}
    .nav-links{display:none;}
    .nav-links.open{display:flex;flex-direction:column;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#FFFFFF;align-items:center;justify-content:center;gap:28px;z-index:9999;margin:0;padding:0;}
    .hamburger{display:flex;}
  }

  .page-wrapper { position:relative; z-index:1; padding-top:100px; min-height:100vh; }

  .page-header { max-width:800px; margin:0 auto; padding:50px 24px 40px; text-align:center; }
  .section-tag { font-size:12px; letter-spacing:4px; text-transform:uppercase; color:#5B21B6; margin-bottom:12px; }
  .page-title { font-family:var(--font-display); font-size:clamp(1.8rem,3vw,2.5rem); font-weight:800; letter-spacing:-0.03em; color:#111111; margin-bottom:14px; }
  .page-title span { color:#5B21B6; -webkit-text-fill-color:#5B21B6; }
  .last-updated { color:#666666; font-size:13px; }

  /* LAYOUT */
  .content-layout { max-width:900px; margin:0 auto; padding:0 24px 80px;
    display:grid; grid-template-columns:220px 1fr; gap:40px; align-items:start; }

  /* SIDEBAR */
  .toc { position:sticky; top:110px; background:#FFFFFF;
    border:1px solid rgba(139,0,255,0.2); border-radius:16px; padding:24px; }
  .toc-title { font-family:var(--font-display); font-size:13px; font-weight:700; color:#5B21B6;
    letter-spacing:2px; text-transform:uppercase; margin-bottom:16px; }
  .toc-list { list-style:none; display:flex; flex-direction:column; gap:8px; }
  .toc-list a { color:#555555; text-decoration:none; font-size:13px; transition:color 0.3s;
    line-height:1.5; display:block; padding:4px 0; border-left:2px solid transparent;
    padding-left:10px; transition:all 0.2s; }
  .toc-list a:hover { color:#5B21B6; border-left-color:#5B21B6; }

  /* CONTENT */
  .policy-content { }
  .policy-section { margin-bottom:40px; scroll-margin-top:120px; }
  .policy-section h2 { font-family:var(--font-display); font-size:20px; font-weight:700; color:#111111;
    margin-bottom:16px; padding-bottom:10px; border-bottom:1px solid #E5E5E5; }
  .policy-section p { font-size:14px; color:#333333; line-height:1.9; margin-bottom:14px; }
  .policy-section ul { padding-left:20px; margin-bottom:14px; }
  .policy-section ul li { font-size:14px; color:#333333; line-height:1.9; margin-bottom:6px; }
  .policy-section ul li::marker { color:#5B21B6; }
  .policy-section ol { padding-left:20px; margin-bottom:14px; }
  .policy-section ol li { font-size:14px; color:#333333; line-height:1.9; margin-bottom:6px; }
  .policy-section ol li::marker { color:#5B21B6; }
  .policy-section li p { margin:0; }
  .policy-section blockquote { background:#EDE9FE; border:1px solid rgba(91,33,182,0.25); border-radius:12px; padding:18px 20px; margin:0 0 16px; }
  .policy-section blockquote p { margin-bottom:0; color:#444444; }
  .policy-section a { color:#5B21B6; }
  .cms-legal h2 { font-family:var(--font-display); font-size:20px; font-weight:700; color:#111111; margin:24px 0 12px; }
  .cms-legal p { font-size:14px; color:#333; line-height:1.9; margin-bottom:14px; }
  .cms-legal ul { padding-left:20px; margin-bottom:14px; }
  .highlight-box { background:rgba(139,0,255,0.08); border:1px solid rgba(139,0,255,0.2);
    border-radius:12px; padding:18px 20px; margin-bottom:16px; }
  .highlight-box p { margin-bottom:0; color:#444444; }

  footer { position:relative; z-index:1; padding:40px 60px;
    border-top:1px solid rgba(139,0,255,0.15);
    display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; }
  .footer-logo { font-family:var(--font-display); font-size:16px; font-weight:800; color:#FFFFFF; }
  .footer-links { display:flex; gap:20px; list-style:none; flex-wrap:wrap; }
  .footer-links a { color:rgba(255,255,255,0.6); text-decoration:none; font-size:13px; transition:color 0.3s; }
  .footer-links a:hover { color:#5B21B6; }
  .footer-copy { font-size:12px; color:rgba(255,255,255,0.3); }

  .whatsapp-btn { position:fixed; bottom:30px; right:30px; z-index:999; width:58px; height:58px;
    border-radius:50%; background:linear-gradient(135deg,#25d366,#128c7e);
    display:flex; align-items:center; justify-content:center;
    box-shadow:0 4px 25px rgba(37,211,102,0.5); text-decoration:none; font-size:26px; transition:all 0.3s; }
  .whatsapp-btn:hover { transform:scale(1.15); }

  @media(max-width:768px){
    .content-layout{grid-template-columns:1fr;}
    .toc{display:none;}
    footer{padding:30px 24px;flex-direction:column;text-align:center;}
  }
`;

export default function PrivacyPolicyPage() {
  const contact = useContactConfig();
  const sc = useSiteContent();
  const legal = renderLegalBody(
    cmsText(sc, "privacy_content", ""),
    LEGAL_DEFAULT_HTML.privacy,
    { email: contact.email, phone: contact.phone },
  );

  return (
    <>
      <style>{styles}</style>

      <Navbar cta="shop" shopHref="/" />

      <div className="page-wrapper">
        <div className="page-header">
          <div className="section-tag">✦ {cmsText(sc, "legal_tag", "Legal")}</div>
          <h1 className="page-title">{cmsText(sc, "privacy_title", "Privacy Policy")}</h1>
          <p className="last-updated">{cmsText(sc, "privacy_updated", "Last updated: 25 November 2026")}</p>
        </div>

        <div className="content-layout">
          <aside className="toc">
            <div className="toc-title">Contents</div>
            <ul className="toc-list">
              {legal.toc.map((item) => (
                <li key={item.id}><a href={"#" + item.id}>{item.label}</a></li>
              ))}
            </ul>
          </aside>

          <div className="policy-content cms-legal" dangerouslySetInnerHTML={{ __html: legal.html }} />
        </div>

        <SiteFooter />
      </div>

    </>
  );
}
