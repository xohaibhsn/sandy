"use client";
import { useState, useEffect } from "react";
import xss from "xss";
import { fixContentLinkRels } from "@/lib/seoLinks";
import { looksLikeHtml } from "@/lib/contentHtml";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import { cmsText, useSiteContent } from "@/hooks/useSiteContent";

const richXss = {
  whiteList: {
    h1: [], h2: [], h3: [], h4: [],
    p: ["style", "class"],
    strong: [], em: [], u: [], s: [], b: [], i: [],
    ul: [], ol: [], li: [],
    blockquote: [],
    a: ["href", "target", "rel"],
    br: [], hr: [],
    span: ["style", "class"],
    div: ["style", "class"],
  } as Record<string, string[]>,
  stripIgnoreTag: true,
};

function renderRichOrPlain(htmlOrText: string, fallback: string) {
  const value = (htmlOrText || "").trim() || fallback;
  if (looksLikeHtml(value)) {
    return { __html: fixContentLinkRels(xss(value, richXss)) };
  }
  return { __html: xss(`<p>${value}</p>`, richXss) };
}

const styles = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body { background:#FFFFFF; color:#111111; font-family:var(--font-body); overflow-x:hidden; }

  nav { position:fixed; top:0; left:0; right:0; z-index:100; padding:18px 60px;
    display:flex; align-items:center; justify-content:space-between;
    background:#FFFFFF; border-bottom:1px solid #E5E5E5; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
  .nav-logo { font-family:var(--font-logo); font-size:20px; font-weight:800; color:#111111;
    text-decoration:none; letter-spacing:2px; }
  .nav-links { display:flex; gap:36px; list-style:none; }
  .nav-links a { color:#111111; text-decoration:none; font-size:13px; font-weight:500; letter-spacing:1.5px; text-transform:uppercase; transition:color 0.2s; }
  .nav-links a:hover { color:#5B21B6; }
  .nav-cta { background:#5B21B6 !important; color:#FFFFFF !important; padding:10px 24px !important; border-radius:30px !important; font-weight:600 !important; }
  .nav-cta:hover { background:#4C1D95 !important; }
  .hamburger { display:none; flex-direction:column; gap:5px; cursor:pointer; background:none; border:none; padding:6px; z-index:101; }
  .hamburger span { display:block; width:25px; height:2px; background:#111111; border-radius:2px; }
  @media(max-width:768px){
    nav{padding:16px 24px;}
    .nav-links{display:none;}
    .nav-links.open{display:flex;flex-direction:column;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#FFFFFF;align-items:center;justify-content:center;gap:28px;z-index:9999;margin:0;padding:0;}
    .nav-links.open a{color:#111111;font-size:18px;}
    .hamburger{display:flex;}
  }

  .page-wrapper { padding-top:100px; min-height:100vh; background:#FFFFFF; }

  /* HERO — light bg, dark text */
  .about-hero { max-width:900px; margin:0 auto; padding:60px 24px 50px; text-align:center; }
  .section-tag { font-size:12px; letter-spacing:4px; text-transform:uppercase; color:#5B21B6; margin-bottom:12px; display:block; font-weight:600; }
  .page-title { font-family:var(--font-display); font-size:clamp(1.8rem,3vw,2.5rem); font-weight:800; letter-spacing:-0.03em; color:#111111; margin-bottom:20px; line-height:1.1; }
  .page-title span { color:#5B21B6; -webkit-text-fill-color:#5B21B6; }
  .hero-text { font-size:clamp(15px,2vw,18px); color:#555555; line-height:1.8; max-width:700px; margin:0 auto 40px; }
  .hero-text p { margin:0 0 12px; }
  .hero-text a { color:#5B21B6; }
  .hero-text ul, .hero-text ol { text-align:left; margin:0 auto 12px; max-width:640px; padding-left:1.2em; }
  .hero-text strong { color:#111111; }

  /* STATS — white cards, dark text */
  .stats-bar { max-width:900px; margin:0 auto; padding:0 24px 70px;
    display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:20px; }
  .stat-card { background:#FFFFFF; border:1px solid #E5E5E5; border-radius:18px; padding:28px 20px; text-align:center;
    box-shadow:0 2px 8px rgba(0,0,0,0.05); transition:all 0.3s; }
  .stat-card:hover { transform:translateY(-5px); border-color:#5B21B6; box-shadow:0 8px 24px rgba(91,33,182,0.12); }
  .stat-number { font-family:var(--font-display); font-size:36px; font-weight:800; color:#5B21B6; }
  .stat-label { font-size:12px; color:#666666; letter-spacing:2px; text-transform:uppercase; margin-top:6px; }

  /* STORY — light bg, dark text, light purple visual card */
  .story-section { max-width:1100px; margin:0 auto; padding:0 24px 80px;
    display:grid; grid-template-columns:1fr 1fr; gap:50px; align-items:center; }
  .story-text .section-tag { text-align:left; }
  .story-title { font-family:var(--font-display); font-size:clamp(24px,3vw,38px); font-weight:700; color:#111111; margin-bottom:20px; }
  .story-title span { color:#5B21B6; -webkit-text-fill-color:#5B21B6; }
  .story-para { font-size:15px; color:#444444; line-height:1.9; margin-bottom:16px; }
  .story-para p { margin:0 0 12px; }
  .story-para a { color:#5B21B6; }
  .story-para ul, .story-para ol { margin:0 0 12px; padding-left:1.2em; }
  .story-para strong { color:#111111; }
  .story-para h2, .story-para h3, .story-para h4 { color:#111111; font-family:var(--font-display); margin:0 0 10px; }
  .story-visual { background:#F5F3FF; border:1px solid #DDD6FE; border-radius:24px; padding:36px;
    display:flex; flex-direction:column; gap:16px; }
  .story-point { display:flex; gap:14px; align-items:flex-start; }
  .point-icon { font-size:24px; flex-shrink:0; margin-top:2px; }
  .point-text h4 { font-size:15px; font-weight:700; color:#111111; margin-bottom:4px; }
  .point-text p { font-size:13px; color:#555555; line-height:1.6; }

  /* VALUES — white cards, dark text */
  .values-section { background:#F5F5F5; padding:60px 0 80px; }
  .values-inner { max-width:1100px; margin:0 auto; padding:0 24px; }
  .section-header { margin-bottom:40px; }
  .section-title { font-family:var(--font-display); font-size:clamp(24px,3vw,38px); font-weight:700; color:#111111; }
  .section-title span { color:#5B21B6; -webkit-text-fill-color:#5B21B6; }
  .values-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:20px; }
  .value-card { background:#FFFFFF; border:1px solid #E5E5E5; border-radius:16px; padding:28px 24px;
    box-shadow:0 1px 4px rgba(0,0,0,0.04); transition:all 0.3s; }
  .value-card:hover { transform:translateY(-4px); border-color:#5B21B6; box-shadow:0 8px 24px rgba(91,33,182,0.1); }
  .value-icon { font-size:32px; margin-bottom:14px; display:block; }
  .value-title { font-family:var(--font-display); font-size:16px; font-weight:700; color:#111111; margin-bottom:8px; }
  .value-desc { font-size:14px; color:#666666; line-height:1.7; }

  /* TIMELINE — light bg, dark text */
  .timeline-section { max-width:800px; margin:0 auto; padding:60px 24px 80px; }
  .timeline { display:flex; flex-direction:column; gap:0; margin-top:40px; }
  .timeline-item { display:flex; gap:20px; }
  .tl-left { display:flex; flex-direction:column; align-items:center; width:40px; flex-shrink:0; }
  .tl-dot { width:40px; height:40px; border-radius:50%; flex-shrink:0;
    background:#5B21B6; display:flex; align-items:center; justify-content:center; font-size:16px;
    box-shadow:0 4px 12px rgba(91,33,182,0.3); }
  .tl-line { width:2px; flex:1; min-height:20px; background:#E5E5E5; margin:4px 0; }
  .tl-content { padding:4px 0 32px; flex:1; }
  .tl-year { font-size:11px; letter-spacing:3px; text-transform:uppercase; color:#5B21B6; margin-bottom:6px; font-weight:600; }
  .tl-title { font-family:var(--font-display); font-size:17px; font-weight:700; color:#111111; margin-bottom:6px; }
  .tl-desc { font-size:14px; color:#555555; line-height:1.6; }

  /* CTA — DARK section (like homepage CTA) */
  .cta-section { margin:0 60px 80px; }
  .cta-box { background:#111111; border-radius:20px; padding:70px 60px; text-align:center; }
  .cta-title { font-family:var(--font-display); font-size:clamp(22px,3vw,36px); font-weight:700; color:#FFFFFF; margin-bottom:14px; }
  .cta-sub { color:rgba(255,255,255,0.65); font-size:15px; margin-bottom:36px; }
  .cta-btns { display:flex; gap:16px; justify-content:center; flex-wrap:wrap; }
  .btn-primary { background:#5B21B6; color:#FFFFFF; padding:15px 40px; border-radius:8px;
    font-size:14px; font-weight:600; letter-spacing:1px; text-transform:uppercase; text-decoration:none;
    transition:all 0.2s; display:inline-block; }
  .btn-primary:hover { background:#4C1D95; transform:translateY(-2px); box-shadow:0 4px 14px rgba(91,33,182,0.4); }
  .btn-secondary { background:transparent; color:#FFFFFF; padding:15px 40px; border-radius:8px;
    font-size:14px; font-weight:600; letter-spacing:1px; text-transform:uppercase;
    text-decoration:none; border:2px solid rgba(255,255,255,0.4); transition:all 0.2s; display:inline-block; }
  .btn-secondary:hover { background:rgba(255,255,255,0.08); border-color:#FFFFFF; transform:translateY(-2px); }

  /* FOOTER — dark */
  footer { background:#111111; padding:50px 60px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:20px; }
  .footer-logo { font-family:var(--font-display); font-size:17px; font-weight:800; color:#FFFFFF; }
  .footer-links { display:flex; gap:24px; list-style:none; flex-wrap:wrap; }
  .footer-links a { color:rgba(255,255,255,0.6); text-decoration:none; font-size:13px; transition:color 0.2s; }
  .footer-links a:hover { color:#FFFFFF; }
  .footer-copy { font-size:12px; color:rgba(255,255,255,0.4); }

  .whatsapp-btn { position:fixed; bottom:30px; right:30px; z-index:999; width:58px; height:58px;
    border-radius:50%; background:linear-gradient(135deg,#25d366,#128c7e);
    display:flex; align-items:center; justify-content:center;
    box-shadow:0 4px 25px rgba(37,211,102,0.5); text-decoration:none; font-size:26px; transition:all 0.3s; }
  .whatsapp-btn:hover { transform:scale(1.1); }

  @media(max-width:768px){
    .story-section{grid-template-columns:1fr;gap:30px;}
    .cta-section{margin:0 16px 60px;}
    .cta-box{padding:48px 24px;}
    footer{padding:36px 24px;flex-direction:column;text-align:center;}
  }
`;

export default function AboutPage() {
  const sc = useSiteContent();
  const [sec, setSec] = useState<Record<string, any>>({});

  useEffect(() => {
    fetch("/api/sections?page=about")
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d)) return;
        const map: Record<string, any> = {};
        d.forEach((s: any) => { map[s.key] = s.data; });
        setSec(map);
      })
      .catch(() => {});
  }, []);

  const hero = sec.about_hero || {};
  const missionSec = sec.about_mission || {};
  const valuesSec = sec.about_values;
  const pageTitle = (hero.title || "").trim() || cmsText(sc, "about_title", "Your Pakistani Online Store");
  const pageSub = (hero.subtitle || "").trim();
  const extraStory = cmsText(sc, "about_story_extra", "Today we serve customers nationwide, starting with accessories and growing into a multi-category general store — all backed by WhatsApp support from our team in Lahore.\n\nEvery order is personally handled. No bots. No long waits. Just real people who care about getting your order to you quickly and correctly.");
  const stats = [
    { number: cmsText(sc, "about_stat1_num", "500+"), label: cmsText(sc, "about_stat1_label", "Happy Customers") },
    { number: cmsText(sc, "about_stat2_num", "99%"), label: cmsText(sc, "about_stat2_label", "Satisfaction Rate") },
    { number: cmsText(sc, "about_stat3_num", "24/7"), label: cmsText(sc, "about_stat3_label", "Support Available") },
    { number: cmsText(sc, "about_stat4_num", "2+"), label: cmsText(sc, "about_stat4_label", "Years in Business") },
    { number: cmsText(sc, "about_stat5_num", "1000+"), label: cmsText(sc, "about_stat5_label", "Orders Fulfilled") },
  ];
  const valueItems = Array.isArray(valuesSec?.items) && valuesSec.items.length
    ? valuesSec.items
    : [
        { icon: "🔒", title: "Transparency", desc: "No hidden charges, no confusing terms. We tell you exactly what you're getting before you buy." },
        { icon: "⚡", title: "Speed", desc: "Fast order processing, quick delivery, and instant support responses — we value your time." },
        { icon: "💬", title: "Real Support", desc: "Our WhatsApp team is staffed by real humans who know our products." },
        { icon: "✅", title: "Quality", desc: "We only sell products we trust." },
        { icon: "🤝", title: "Reliability", desc: "We follow through on every promise — from delivery times to after-sales support." },
        { icon: "💰", title: "Value", desc: "Premium products at fair prices. We believe quality shouldn't cost a fortune." },
      ];

  return (
    <>
      <style>{styles}</style>

      <Navbar cta="shop" shopHref="/" />

      <div className="page-wrapper">

        {/* HERO */}
        <div className="about-hero">
          <div className="section-tag">✦ Our Story</div>
          <h1 className="page-title">{pageTitle}</h1>
          {pageSub ? <p className="hero-text" style={{marginBottom:16}}>{pageSub}</p> : null}
          <div
            className="hero-text"
            dangerouslySetInnerHTML={renderRichOrPlain(
              sc.about_description || "",
              "Sandy is a Pakistani online store based in Lahore. We started with a simple idea — quality products, honest prices, and delivery you can rely on."
            )}
          />
        </div>

        {/* STATS */}
        <div className="stats-bar">
          {stats.map((s, i) => (
            <div className="stat-card" key={i}>
              <div className="stat-number">{s.number}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>

        {/* STORY */}
        <div className="story-section">
          <div className="story-text">
            <div className="section-tag">✦ Who We Are</div>
            <h2 className="story-title">Built on <span>Trust</span></h2>
            <div
              className="story-para"
              dangerouslySetInnerHTML={renderRichOrPlain(
                sc.about_mission || missionSec.text || "",
                "Sandy was founded to make everyday shopping easier across Pakistan — authentic products, fair prices, and real human support."
            )}
            />
            {extraStory.split(/\n\n+/).map((para, i) => (
              <p className="story-para" key={i}>{para}</p>
            ))}
          </div>
          <div className="story-visual">
            {[
              { icon: "🇵🇰", title: "Pakistan Based", desc: "We operate from Lahore and deliver across Pakistan." },
              { icon: "🤝", title: "Personal Service", desc: "Every customer gets direct WhatsApp support from our team." },
              { icon: "⚡", title: "Fast & Reliable", desc: "Orders processed quickly after confirmation." },
              { icon: "💰", title: "Fair Pricing", desc: "No hidden fees. What you see is what you pay." },
            ].map((p, i) => (
              <div className="story-point" key={i}>
                <span className="point-icon">{p.icon}</span>
                <div className="point-text">
                  <h4>{p.title}</h4>
                  <p>{p.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* VALUES */}
        <div className="values-section">
          <div className="values-inner">
          <div className="section-header">
            <div className="section-tag">✦ What We Stand For</div>
            <h2 className="section-title">{valuesSec?.title || "Our Values"}</h2>
          </div>
          <div className="values-grid">
            {valueItems.map((v: any, i: number) => (
              <div className="value-card" key={i}>
                <span className="value-icon">{v.icon}</span>
                <div className="value-title">{v.title}</div>
                <div className="value-desc">{v.desc || v.description}</div>
              </div>
            ))}
          </div>
          </div>
        </div>

        {/* TIMELINE */}
        <div className="timeline-section">
          <div className="section-tag">✦ Our Journey</div>
          <h2 className="section-title">How We <span>Grew</span></h2>
          <div className="timeline">
            {[
              { year: "2026", icon: "🚀", title: "Sandy launches", desc: "Sandy opened as a Pakistani online store, starting with accessories and nationwide delivery." },
              { year: "2026", icon: "📦", title: "Growing catalogue", desc: "We are expanding into more categories so you can shop everyday essentials in one place." },
              { year: "2026", icon: "💬", title: "WhatsApp support", desc: "Direct WhatsApp support from our Lahore team — real people, fast replies." },
              { year: "2026", icon: "🌟", title: "Nationwide delivery", desc: "Cash on Delivery, JazzCash, Easypaisa and bank transfer across Pakistan." },
              { year: "2026", icon: "🛍️", title: "New website", desc: "Launched our custom-built website with order tracking and easy checkout." },
            ].map((t, i) => (
              <div className="timeline-item" key={i}>
                <div className="tl-left">
                  <div className="tl-dot">{t.icon}</div>
                  {i < 4 && <div className="tl-line" />}
                </div>
                <div className="tl-content">
                  <div className="tl-year">{t.year}</div>
                  <div className="tl-title">{t.title}</div>
                  <div className="tl-desc">{t.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="cta-section">
          <div className="cta-box">
            <h2 className="cta-title">{cmsText(sc, "about_cta_title", "Ready to Shop With Us?")}</h2>
            <p className="cta-sub">{cmsText(sc, "about_cta_sub", "Join customers across Pakistan. Fast delivery. Real support.")}</p>
            <div className="cta-btns">
              <a href="/products" className="btn-primary">Browse Products</a>
              <a href="/contact" className="btn-secondary">Get In Touch</a>
            </div>
          </div>
        </div>

        <SiteFooter />
      </div>

    </>
  );
}