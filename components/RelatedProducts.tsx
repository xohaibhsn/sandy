import Link from "next/link";
import SmartImage from "@/components/SmartImage";
import { formatPrice } from "@/lib/site";
import { imageMode } from "@/lib/imageLoader";
import type { RelatedProductCard } from "@/lib/relatedProducts";

export default function RelatedProducts({
  title,
  products,
}: {
  title: string;
  products: RelatedProductCard[];
}) {
  if (!products || products.length === 0) return null;

  return (
    <section className="related-products" aria-label={title}>
      <style>{`
        .related-products{margin-top:48px;padding-top:32px;border-top:1px solid #E8E4DF;}
        .related-products h2{font-family:var(--font-display);font-size:clamp(20px,2.4vw,28px);font-weight:700;letter-spacing:-0.02em;color:#111;margin:0 0 20px;}
        .related-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;}
        .related-card{display:flex;flex-direction:column;text-decoration:none;color:inherit;min-width:0;}
        .related-card:hover .related-name{opacity:0.7;}
        .related-img{position:relative;aspect-ratio:1;background:#F7F5F2;overflow:hidden;margin-bottom:12px;}
        .related-img img{object-fit:cover;}
        .related-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#9CA3AF;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;}
        .related-badge{position:absolute;top:10px;left:10px;z-index:1;background:#111;color:#fff;font-size:10px;font-weight:600;padding:4px 8px;letter-spacing:0.08em;}
        .related-name{font-family:var(--font-display);font-size:15px;font-weight:600;color:#111;line-height:1.35;margin:0 0 6px;}
        .related-price{font-family:var(--font-display);font-size:14px;font-weight:600;color:#111;margin:0;}
        .related-oos{font-size:12px;color:#6B6560;margin-top:4px;letter-spacing:0.04em;}
        @media(max-width:640px){.related-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;}}
      `}</style>
      <h2>{title}</h2>
      <div className="related-grid">
        {products.map((p) => {
          const mode = imageMode(p.image);
          return (
            <Link key={p.id} href={`/products/${p.slug}`} className="related-card">
              <div className="related-img">
                {p.badge ? <span className="related-badge">{p.badge}</span> : null}
                {mode === "empty" ? (
                  <div className="related-placeholder">Product</div>
                ) : (
                  <SmartImage
                    src={p.image}
                    alt={p.name}
                    fill
                    sizes="(max-width:640px) 50vw, 25vw"
                    style={{ objectFit: "cover" }}
                  />
                )}
              </div>
              <div className="related-name">{p.name}</div>
              <div className="related-price">{formatPrice(p.price)}</div>
              {p.outOfStock ? <div className="related-oos">Out of stock</div> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
