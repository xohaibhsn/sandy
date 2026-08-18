"use client";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import { useContactConfig } from "@/hooks/useContactConfig";
import { cmsText, useSiteContent } from "@/hooks/useSiteContent";
import xss from "xss";

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

  /* SUMMARY CARDS */
  .summary-cards { max-width:900px; margin:0 auto; padding:0 24px 50px;
    display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:16px; }
  .summary-card { background:#FFFFFF;
    border:1px solid rgba(139,0,255,0.2); border-radius:16px; padding:24px 20px; text-align:center; }
  .summary-card-icon { font-size:32px; margin-bottom:10px; display:block; }
  .summary-card-title { font-family:var(--font-display); font-size:14px; font-weight:700; color:#111111; margin-bottom:6px; }
  .summary-card-text { font-size:13px; color:#555555; line-height:1.6; }

  .content-layout { max-width:900px; margin:0 auto; padding:0 24px 80px; display:grid; grid-template-columns:220px 1fr; gap:40px; align-items:start; }
  .toc { position:sticky; top:110px; background:#FFFFFF; border:1px solid rgba(139,0,255,0.2); border-radius:16px; padding:24px; }
  .toc-title { font-family:var(--font-display); font-size:13px; font-weight:700; color:#5B21B6; letter-spacing:2px; text-transform:uppercase; margin-bottom:16px; }
  .toc-list { list-style:none; display:flex; flex-direction:column; gap:8px; }
  .toc-list a { color:#555555; text-decoration:none; font-size:13px; line-height:1.5; display:block; padding:4px 0 4px 10px; border-left:2px solid transparent; transition:all 0.2s; }
  .toc-list a:hover { color:#5B21B6; border-left-color:#5B21B6; }
  .policy-section { margin-bottom:40px; scroll-margin-top:120px; }
  .policy-section h2 { font-family:var(--font-display); font-size:20px; font-weight:700; color:#111111; margin-bottom:16px; padding-bottom:10px; border-bottom:1px solid #E5E5E5; }
  .policy-section p { font-size:14px; color:#333333; line-height:1.9; margin-bottom:14px; }
  .policy-section ul { padding-left:20px; margin-bottom:14px; }
  .policy-section ul li { font-size:14px; color:#333333; line-height:1.9; margin-bottom:6px; }
  .policy-section ul li::marker { color:#5B21B6; }
  .highlight-box { background:#EDE9FE; border:1px solid rgba(91,33,182,0.25); border-radius:12px; padding:18px 20px; margin-bottom:16px; }
  .highlight-box p { margin-bottom:0; color:#444444; }
  .warning-box { background:#FEF3C7; border:1px solid rgba(234,179,8,0.3); border-radius:12px; padding:18px 20px; margin-bottom:16px; }
  .warning-box p { margin-bottom:0; color:#92400E; }

  /* CTA */
  .contact-cta { max-width:900px; margin:0 auto 80px; padding:0 24px; }
  .cta-box { background:linear-gradient(135deg,rgba(74,0,128,0.3),rgba(139,0,255,0.15));
    border:1px solid rgba(139,0,255,0.3); border-radius:24px; padding:50px 40px; text-align:center; }
  .cta-title { font-family:var(--font-display); font-size:clamp(20px,2.5vw,28px); font-weight:700; color:#111111; margin-bottom:12px; }
  .cta-sub { color:#555555; font-size:14px; margin-bottom:28px; }
  .cta-btns { display:flex; gap:14px; justify-content:center; flex-wrap:wrap; }
  .btn-wa { background:linear-gradient(135deg,#25d366,#128c7e); color:#111111; padding:13px 30px; border-radius:50px; text-decoration:none; font-size:14px; font-weight:600; transition:all 0.3s; }
  .btn-wa:hover { box-shadow:0 0 20px rgba(37,211,102,0.5); transform:translateY(-2px); }
  .btn-contact { background:transparent; color:#EDE9FE; padding:13px 30px; border-radius:50px; text-decoration:none; font-size:14px; font-weight:600; border:1px solid rgba(139,0,255,0.5); transition:all 0.3s; }
  .btn-contact:hover { background:rgba(139,0,255,0.15); transform:translateY(-2px); }

  footer { position:relative; z-index:1; padding:40px 60px; border-top:1px solid rgba(139,0,255,0.15); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; }
  .footer-logo { font-family:var(--font-display); font-size:16px; font-weight:800; color:#FFFFFF; }
  .footer-links { display:flex; gap:20px; list-style:none; flex-wrap:wrap; }
  .footer-links a { color:rgba(255,255,255,0.6); text-decoration:none; font-size:13px; transition:color 0.3s; }
  .footer-links a:hover { color:#5B21B6; }
  .footer-copy { font-size:12px; color:rgba(255,255,255,0.3); }
  .whatsapp-btn { position:fixed; bottom:30px; right:30px; z-index:999; width:58px; height:58px; border-radius:50%; background:linear-gradient(135deg,#25d366,#128c7e); display:flex; align-items:center; justify-content:center; box-shadow:0 4px 25px rgba(37,211,102,0.5); text-decoration:none; font-size:26px; transition:all 0.3s; }
  .whatsapp-btn:hover { transform:scale(1.15); }
  @media(max-width:768px){ .content-layout{grid-template-columns:1fr;} .toc{display:none;} .cta-box{padding:36px 24px;} footer{padding:30px 24px;flex-direction:column;text-align:center;} }
`;

export default function RefundPolicyPage() {
  const contact = useContactConfig();
  const sc = useSiteContent();
  const cmsBody = cmsText(sc, "refund_content", "");

  return (
    <>
      <style>{styles}</style>
      <Navbar cta="shop" shopHref="/" />

      <div className="page-wrapper">
        <div className="page-header">
          <div className="section-tag">✦ {cmsText(sc, "legal_tag", "Legal")}</div>
          <h1 className="page-title">{cmsText(sc, "refund_title", "Refund Policy")}</h1>
          <p className="last-updated">{cmsText(sc, "refund_updated", "Last updated: 30 May 2026")}</p>
        </div>

        {/* SUMMARY CARDS */}
        <div className="summary-cards">
          {[
            { icon: "📦", title: cmsText(sc, "refund_sum1_title", "Physical Products"), text: cmsText(sc, "refund_sum1_text", "14-day return window from delivery date") },
            { icon: "💳", title: cmsText(sc, "refund_sum2_title", "Prepaid Orders"), text: cmsText(sc, "refund_sum2_text", "Refunds after we confirm the return") },
            { icon: "⚠️", title: cmsText(sc, "refund_sum3_title", "Faulty Items"), text: cmsText(sc, "refund_sum3_text", "Full refund or replacement at no cost") },
            { icon: "🚚", title: cmsText(sc, "refund_sum4_title", "Return Postage"), text: cmsText(sc, "refund_sum4_text", "Customer's responsibility unless item is faulty") },
          ].map((c, i) => (
            <div className="summary-card" key={i}>
              <span className="summary-card-icon">{c.icon}</span>
              <div className="summary-card-title">{c.title}</div>
              <div className="summary-card-text">{c.text}</div>
            </div>
          ))}
        </div>

        <div className="content-layout">
          <aside className="toc">
            <div className="toc-title">Contents</div>
            <ul className="toc-list">
              <li><a href="#overview">1. Overview</a></li>
              <li><a href="#physical">2. Physical Products</a></li>
              <li><a href="#subscriptions">3. Subscriptions</a></li>
              <li><a href="#faulty">4. Faulty Items</a></li>
              <li><a href="#process">5. Return Process</a></li>
              <li><a href="#refund-timing">6. Refund Timing</a></li>
              <li><a href="#exceptions">7. Exceptions</a></li>
              <li><a href="#contact">8. Contact Us</a></li>
            </ul>
          </aside>

          {cmsBody ? (
            <div className="policy-content cms-legal" dangerouslySetInnerHTML={{ __html: xss(cmsBody) }} />
          ) : (
          <div className="policy-content">
            <div className="policy-section" id="overview">
              <h2>1. Overview</h2>
              <div className="highlight-box">
                <p>Faulty items are replaced or refunded. Unused items in original condition may be returned as described below.</p>
              </div>
              <p>This Refund Policy applies to all purchases made on sandy.com.pk. By placing an order, you agree to the terms set out in this policy.</p>
            </div>

            <div className="policy-section" id="physical">
              <h2>2. Physical Products</h2>
              <p>We accept returns on physical products under the following conditions:</p>
              <ul>
                <li>Return request must be made within <strong>14 days</strong> of the delivery date.</li>
                <li>The item must be <strong>unused</strong> and in its <strong>original packaging</strong>.</li>
                <li>All accessories and documentation originally included must be returned.</li>
                <li>Items showing signs of use, damage, or tampering will not be accepted for return.</li>
              </ul>
              <p>Once we receive and inspect the returned item, we will process your refund within 5-7 working days to your original payment method or via bank transfer.</p>
            </div>

            <div className="policy-section" id="subscriptions">
              <h2>3. Digital / Non-returnable items</h2>
              <p>Some items may be marked as non-returnable (for example opened hygiene products or digital goods). These will be stated on the product page.</p>
            </div>

            <div className="policy-section" id="faulty">
              <h2>4. Faulty or Damaged Items</h2>
              <p>If you receive a faulty or damaged item, please contact us immediately (within 48 hours of delivery) with:</p>
              <ul>
                <li>Your Order ID</li>
                <li>A clear description of the fault or damage</li>
                <li>Photos or video evidence of the issue</li>
              </ul>
              <p>We will offer one of the following resolutions at no additional cost to you:</p>
              <ul>
                <li><strong>Replacement</strong> — we will send a replacement item.</li>
                <li><strong>Full refund</strong> — a complete refund including any delivery charges paid.</li>
              </ul>
              <p>We will cover return postage costs for faulty or damaged items.</p>
            </div>

            <div className="policy-section" id="process">
              <h2>5. How to Return an Item</h2>
              <p>To initiate a return, please follow these steps:</p>
              <ul>
                <li>Contact us via WhatsApp ({contact.phone}) or email ({contact.email}) with your Order ID and reason for return.</li>
                <li>Wait for our team to confirm your return request and provide return instructions.</li>
                <li>Package the item securely in its original packaging.</li>
                <li>Send the item to the address provided by our team.</li>
                <li>Share your tracking number with us once posted.</li>
              </ul>
              <p>Please do not send items back without contacting us first — unrequested returns cannot be processed.</p>
            </div>

            <div className="policy-section" id="refund-timing">
              <h2>6. Refund Timing</h2>
              <p>Once your return has been received and approved:</p>
              <ul>
                <li>Refunds are processed within <strong>5-7 working days</strong>.</li>
                <li>Refunds will be made via the original payment method or a Pakistani bank / wallet transfer.</li>
                <li>We will notify you by email or WhatsApp once the refund has been processed.</li>
              </ul>
            </div>

            <div className="policy-section" id="exceptions">
              <h2>7. Exceptions</h2>
              <p>The following items and situations are not eligible for a refund:</p>
              <ul>
                <li>Items marked as non-returnable on the product page.</li>
                <li>Physical products returned after the 14-day window.</li>
                <li>Items that have been used, damaged by the customer, or returned without original packaging.</li>
                <li>Orders where the customer provided incorrect delivery details.</li>
                <li>Issues caused by incompatible third-party software or misuse of the product.</li>
              </ul>
            </div>

            <div className="policy-section" id="contact">
              <h2>8. Contact Us</h2>
              <p>If you have any questions about our refund policy or wish to initiate a return, please get in touch:</p>
              <div className="highlight-box">
                <p>📧 Email: {contact.email}<br />
                💬 WhatsApp: {contact.phone}<br />
                {contact.telegram ? <>✈️ Telegram: {contact.telegram}<br /></> : null}
                🌐 Website: sandy.com.pk</p>
              </div>
              <p>We aim to respond to all refund and return enquiries within 24 hours during business hours.</p>
            </div>
          </div>
          )}
        </div>

        {/* CTA */}
        <div className="contact-cta">
          <div className="cta-box">
            <div className="cta-title">{cmsText(sc, "refund_cta_title", "Need Help With a Return?")}</div>
            <p className="cta-sub">{cmsText(sc, "refund_cta_sub", "Our team is here to help. Contact us via WhatsApp for the fastest response.")}</p>
            <div className="cta-btns">
              <a href={contact.whatsappUrl} className="btn-wa" target="_blank" rel="noopener noreferrer">💬 {cmsText(sc, "refund_cta_btn", "WhatsApp Us")}</a>
              {contact.telegramUrl ? (
              <a href={contact.telegramUrl} className="btn-contact" target="_blank" rel="noopener noreferrer">✈️ Telegram {contact.telegram}</a>
              ) : null}
              <a href="/contact" className="btn-contact">📧 Email Us</a>
            </div>
          </div>
        </div>

        <SiteFooter />
      </div>

    </>
  );
}