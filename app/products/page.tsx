"use client";
export const dynamic = 'force-dynamic';
import { useEffect, useState, useRef, useCallback } from "react";
import xss from "xss";
import { fixContentLinkRels } from "@/lib/seoLinks";
import { useCart } from "../lib/cartContext";
import BreadcrumbSchema from "@/components/BreadcrumbSchema";
import Navbar from "@/components/Navbar";
import { useContactConfig } from "@/hooks/useContactConfig";
import { SITE_URL, formatPrice } from "@/lib/site";
import SiteFooter from "@/components/SiteFooter";

const cardDescXss = {
  whiteList: {
    p: [], strong: [], em: [], u: [],
    br: [], span: [], a: ["href"],
    ul: [], ol: [], li: [],
  } as Record<string, string[]>,
  stripIgnoreTag: true,
};

interface Product {
  id: number;
  name: string;
  description: string;
  short_description?: string | null;
  slug?: string | null;
  price: number;
  badge: string | null;
  image: string | null;
  category: string;
}

const STARS = Array.from({length:50}).map((_,i) => ({
  left: `${((i * 137.5) % 100).toFixed(2)}%`,
  top: `${((i * 97.3) % 100).toFixed(2)}%`,
  dur: `${2 + (i % 4)}s`,
  op: `${(0.2 + (i % 8) * 0.08).toFixed(2)}`,
  delay: `${(i % 5)}s`
}));

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [added, setAdded] = useState<number | null>(null);
  const [hoveringId, setHoveringId] = useState<number | null>(null);
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState("featured");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const contact = useContactConfig();
  // Live search
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const { addToCart, removeFromCart, cart } = useCart();

  const fetchProducts = useCallback((cat = filter, s = sort, mn = minPrice, mx = maxPrice) => {
    setLoading(true);
    let url = `/api/products?sort=${s}`;
    if (cat !== "All") url += `&category=${encodeURIComponent(cat)}`;
    if (mn) url += `&minPrice=${mn}`;
    if (mx) url += `&maxPrice=${mx}`;
    fetch(url)
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) { setProducts(data); setLoadError(false); } else { setLoadError(true); } setLoading(false); })
      .catch(() => { setLoadError(true); setLoading(false); });
  }, [filter, sort, minPrice, maxPrice]);

  useEffect(() => { fetchProducts(); }, []);

  // Debounced live search
  useEffect(() => {
    if (!searchQ || searchQ.length < 2) { setSearchResults([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(searchQ)}`).then(r=>r.json()).then(d=>{ setSearchResults(Array.isArray(d)?d:[]); setSearchOpen(true); }).catch(()=>{});
    }, 300);
    return () => clearTimeout(t);
  }, [searchQ]);

  useEffect(() => {
    const handle = (e: MouseEvent) => { if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false); };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const handleAddToCart = (p: Product) => {
    addToCart({ id: p.id, name: p.name, price: Number(p.price), qty: 1 });
    setAdded(p.id);
    setTimeout(() => setAdded(null), 1500);
  };

  const applyFilter = (cat: string) => { setFilter(cat); fetchProducts(cat, sort, minPrice, maxPrice); };
  const applySort = (s: string) => { setSort(s); fetchProducts(filter, s, minPrice, maxPrice); };
  const applyPrice = () => fetchProducts(filter, sort, minPrice, maxPrice);

  const categories = ["All", ...Array.from(new Set(products.map(p => p.category).filter(Boolean)))];
  const filtered = products;

  return (
    <>
      <BreadcrumbSchema
        items={[
          { name: "Home", url: SITE_URL },
          { name: "Products", url: `${SITE_URL}/products` },
        ]}
      />
      <style>{`
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        body { background:#FFFFFF; color:#111111; font-family:var(--font-body); overflow-x:hidden; }
        nav { position:fixed; top:0; left:0; right:0; z-index:100; padding:18px 60px; display:flex; align-items:center; justify-content:space-between; background:#FFFFFF; border-bottom:1px solid #E5E5E5; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
        .nav-logo { font-family:var(--font-logo); font-size:20px; font-weight:800; color:#111111; text-decoration:none; letter-spacing:2px; }
        .nav-links { display:flex; gap:36px; list-style:none; }
        .nav-links a { color:#111111; text-decoration:none; font-size:13px; font-weight:500; letter-spacing:1.5px; text-transform:uppercase; transition:color 0.3s; }
        .nav-links a:hover { color:#5B21B6; }
        .nav-cta { background:#5B21B6 !important; color:#FFFFFF !important; padding:10px 24px !important; border-radius:30px !important; font-weight:600 !important; }
        .hamburger { display:none; flex-direction:column; gap:5px; cursor:pointer; background:none; border:none; padding:5px; z-index:101; }
        .hamburger span { display:block; width:25px; height:2px; background:#111111; border-radius:2px; }
        .page-wrapper { position:relative; z-index:1; padding-top:100px; background:#FFFFFF; }
        .page-header { max-width:1300px; margin:0 auto; padding:60px 60px 30px; }
        .section-tag { font-family:var(--font-body); font-size:11px; letter-spacing:0.18em; text-transform:uppercase; color:#6B6560; margin-bottom:12px; font-weight:600; }
        .page-title { font-family:var(--font-display); font-size:clamp(1.8rem,3vw,2.5rem); font-weight:700; letter-spacing:-0.03em; color:#111111; }
        .page-title span { color:#111111; }
        .activation-banner { max-width:1300px; margin:0 auto 24px; padding:0 48px; }
        .activation-banner-inner { background:#F7F5F2; border:none; border-radius:0; padding:14px 0; color:#6B6560; font-size:14px; line-height:1.6; border-bottom:1px solid #E8E4DF; }
        .filters { max-width:1300px; margin:0 auto; padding:0 48px 30px; display:flex; gap:8px; flex-wrap:wrap; }
        .filter-btn { padding:8px 16px; border-radius:2px; border:1px solid #E8E4DF; background:#FFFFFF; color:#111111; font-size:12px; letter-spacing:0.06em; cursor:pointer; transition:all 0.2s; }
        .filter-btn:hover { border-color:#111; }
        .filter-btn.active { background:#111111; color:#FFFFFF; border-color:#111; }
        .products-grid { max-width:1300px; margin:0 auto; padding:0 48px 80px; display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:28px; }
        .product-card { background:#FFFFFF; border:none; border-radius:0; overflow:hidden; transition:opacity 0.3s; position:relative; box-shadow:none; min-width:0; }
        @keyframes fadeInUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        .product-card:hover { transform:none; border-color:transparent; box-shadow:none; opacity:0.88; }
        .product-image { width:100%; aspect-ratio:1/1; background:#F7F5F2; border-bottom:none; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; }
        .product-image img { width:100%; height:100%; object-fit:cover; }
        .image-placeholder { display:flex; flex-direction:column; align-items:center; gap:10px; color:#CCCCCC; }
        .image-placeholder svg { width:48px; height:48px; opacity:0.4; }
        .image-placeholder span { font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#AAAAAA; }
        .badge { position:absolute; top:12px; left:12px; z-index:2; background:#111111; color:#FFFFFF; font-size:10px; font-weight:600; padding:5px 10px; border-radius:0; letter-spacing:0.08em; }
        .badge.gold { background:#111111; color:#FFFFFF; }
        .badge.new { background:#111111; color:#FFFFFF; }
        .badge.bundle { background:#111111; color:#FFFFFF; }
        .product-info { padding:16px 4px 8px; }
        .product-name { font-family:var(--font-display); font-size:15px; font-weight:600; letter-spacing:-0.01em; color:#111111; margin-bottom:6px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; word-break:break-word; }
        .product-desc,.product-short-desc { font-size:13px; color:#6B6560; line-height:1.6; margin-bottom:12px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; }
        .product-short-desc p { margin:0; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden; font-size:13px; color:#6B6560; }
        .product-short-desc strong,.product-desc strong { font-weight:700; color:#333333; }
        .product-short-desc a,.product-desc a { color:#111; text-decoration:underline; }
        .product-footer { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .product-price { font-size:1.05rem; font-weight:600; letter-spacing:-0.02em; color:#111111; font-family:var(--font-display); white-space:nowrap; }
        .add-btn { font-family:var(--font-body); background:#111111; color:#FFFFFF; border:none; padding:9px 16px; border-radius:2px; font-size:11px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; cursor:pointer; transition:all 0.2s; white-space:nowrap; }
        .add-btn:hover { background:#333; }
        .add-btn.added { background:#16A34A; }
        .loading { text-align:center; padding:60px; color:#666666; font-size:18px; }
        footer { background:#111111; padding:50px 60px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:20px; }
        .footer-logo { font-family:var(--font-display); font-size:17px; font-weight:800; color:#FFFFFF; }
        .footer-links { display:flex; gap:24px; list-style:none; flex-wrap:wrap; }
        .footer-links a { color:rgba(255,255,255,0.6); text-decoration:none; font-size:13px; transition:color 0.2s; }
        .footer-links a:hover { color:#FFFFFF; }
        .footer-copy { font-size:12px; color:rgba(255,255,255,0.4); }
        .whatsapp-btn { position:fixed; bottom:30px; right:30px; z-index:999; width:58px; height:58px; border-radius:50%; background:linear-gradient(135deg,#25d366,#128c7e); display:flex; align-items:center; justify-content:center; box-shadow:0 4px 25px rgba(37,211,102,0.5); text-decoration:none; font-size:26px; transition:all 0.3s; }
        .whatsapp-btn:hover { transform:scale(1.1); }
        @media(max-width:768px){
          nav{padding:16px 24px;}
          .nav-links{display:none;}
          .nav-links.open{display:flex;flex-direction:column;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#FFFFFF;align-items:center;justify-content:center;gap:28px;z-index:9999;margin:0;padding:0;}
          .hamburger{display:flex;}
          .page-header{padding:32px 16px 20px;}
          .activation-banner{padding:0 16px;margin-bottom:18px;}
          .filters{padding:0 16px 16px;}
          .products-grid{grid-template-columns:repeat(2,1fr);gap:12px;padding:0 12px 50px;}
          .product-info{padding:10px 12px;}
          .product-name{font-size:12px;}
          .product-desc,.product-short-desc{font-size:11px;margin-bottom:8px;-webkit-line-clamp:2;}
          .product-short-desc p{font-size:11px;}
          .product-price{font-size:14px;}
          .add-btn{padding:7px 10px;font-size:11px;}
          .badge{font-size:9px;padding:3px 7px;top:6px;right:6px;}
          footer{padding:36px 24px;flex-direction:column;text-align:center;}
        }
      `}</style>

      <div className="bg-animated">
        {STARS.map((s,i)=>(
          <div key={i} className="star" style={{left:s.left,top:s.top,"--dur":s.dur,"--op":s.op,animationDelay:s.delay} as React.CSSProperties}/>
        ))}
      </div>

      <Navbar cartCount={cart.length} cta="cart">
        {/* Live Search */}
        <div ref={searchRef} style={{position:"relative",display:"flex",alignItems:"center",gap:8}}>
          {searchActive
            ? <input autoFocus style={{background:"#F5F5F5",border:"1px solid #E5E5E5",borderRadius:20,padding:"7px 16px",color:"#111",fontSize:13,outline:"none",width:220}} placeholder="Search products..." value={searchQ} onChange={e=>setSearchQ(e.target.value)} onKeyDown={e=>e.key==="Escape"&&(setSearchActive(false),setSearchQ(""),setSearchOpen(false))} />
            : <button type="button" style={{background:"none",border:"none",cursor:"pointer",color:"#666",fontSize:20,padding:"4px 8px"}} onClick={()=>setSearchActive(true)} title="Search">🔍</button>
          }
          {searchOpen && searchResults.length > 0 && (
            <div style={{position:"absolute",top:"calc(100% + 8px)",right:0,width:320,background:"#FFFFFF",border:"1px solid #E5E5E5",borderRadius:14,overflow:"hidden",zIndex:200,boxShadow:"0 8px 32px rgba(0,0,0,0.12)"}}>
              {searchResults.map((r:any)=>(
                <a key={r.id} href={`/products/${r.slug}`} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px",textDecoration:"none",borderBottom:"1px solid #F0F0F0",transition:"background 0.15s"}} onMouseEnter={e=>(e.currentTarget.style.background="#F9F9F9")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
                  {r.image ? <img src={r.image} alt={r.name} style={{width:40,height:40,borderRadius:6,objectFit:"cover",border:"1px solid #E5E5E5"}} loading="lazy" /> : <div style={{width:40,height:40,borderRadius:6,background:"#F5F5F5",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📦</div>}
                  <div style={{flex:1,overflow:"hidden"}}>
                    <div style={{fontSize:13,fontWeight:600,color:"#111",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.name}</div>
                    <div style={{fontSize:11,color:"#888"}}>{r.category} · {formatPrice(r.price)}</div>
                  </div>
                </a>
              ))}
              <a href={`/products?q=${encodeURIComponent(searchQ)}`} style={{display:"block",padding:"10px 16px",fontSize:12,color:"#5B21B6",textDecoration:"none",textAlign:"center",background:"#F5F3FF"}}>View all results for &quot;{searchQ}&quot; →</a>
            </div>
          )}
          {searchOpen && searchQ.length >= 2 && searchResults.length === 0 && (
            <div style={{position:"absolute",top:"calc(100% + 8px)",right:0,width:240,background:"#FFFFFF",border:"1px solid #E5E5E5",borderRadius:10,padding:"14px 16px",zIndex:200,fontSize:13,color:"#888"}}>No products found for &quot;{searchQ}&quot;</div>
          )}
        </div>
      </Navbar>

      <div className="page-wrapper">
        <div className="page-header">
          <div className="section-tag">The Collection</div>
          <h1 className="page-title">All products</h1>
        </div>

        <div className="activation-banner">
          <div className="activation-banner-inner">
            Fast delivery across Pakistan. Need help? WhatsApp {contact.phone}.
          </div>
        </div>

        {/* Filters + Sort */}
        <div style={{maxWidth:1300,margin:"0 auto",padding:"0 48px 20px",display:"flex",flexWrap:"wrap",gap:12,alignItems:"center"}}>
          <div className="filters" style={{margin:0,padding:0,flex:1,minWidth:200}}>
            {categories.map(cat => (
              <button key={cat} className={`filter-btn ${filter===cat?"active":""}`} onClick={()=>applyFilter(cat)}>{cat}</button>
            ))}
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            <input type="number" style={{width:80,background:"#FFFFFF",border:"1px solid #E8E4DF",borderRadius:2,padding:"7px 10px",color:"#111",fontSize:13,outline:"none"}} placeholder="Min Rs." value={minPrice} onChange={e=>setMinPrice(e.target.value)} />
            <span style={{color:"#6B6560",fontSize:13}}>—</span>
            <input type="number" style={{width:80,background:"#FFFFFF",border:"1px solid #E8E4DF",borderRadius:2,padding:"7px 10px",color:"#111",fontSize:13,outline:"none"}} placeholder="Max Rs." value={maxPrice} onChange={e=>setMaxPrice(e.target.value)} />
            <button style={{background:"#111",border:"none",color:"#fff",padding:"7px 14px",borderRadius:2,cursor:"pointer",fontSize:12,fontWeight:600,letterSpacing:"0.06em"}} onClick={applyPrice}>Apply</button>
            <select style={{background:"#FFFFFF",border:"1px solid #E8E4DF",borderRadius:2,padding:"7px 10px",color:"#111",fontSize:13,outline:"none",cursor:"pointer"}} value={sort} onChange={e=>applySort(e.target.value)}>
              <option value="featured">Featured</option>
              <option value="price_asc">Price: Low → High</option>
              <option value="price_desc">Price: High → Low</option>
              <option value="newest">Newest</option>
            </select>
          </div>
        </div>

        <div className="products-grid">
          {loading ? (
            <div className="loading">Loading products...</div>
          ) : loadError ? (
            <div className="loading" style={{textAlign:"center",padding:"40px 0"}}>
              <div style={{fontSize:"32px",marginBottom:"12px"}}>⚠️</div>
              <div style={{color:"#111",marginBottom:"8px"}}>Could not load products right now.</div>
              <div style={{color:"#6B6560",fontSize:"13px",marginBottom:"20px"}}>Please try again in a moment or contact us via WhatsApp.</div>
              <button onClick={() => window.location.reload()} style={{background:"#111",color:"white",border:"none",padding:"10px 24px",borderRadius:"2px",cursor:"pointer",fontSize:"13px",letterSpacing:"0.08em",textTransform:"uppercase"}}>Try Again</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="loading">No products found.</div>
          ) : (
            filtered.map((p) => (
              <div className="product-card" key={p.id} onClick={() => window.location.href=`/products/${p.slug || p.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`} style={{cursor:"pointer"}}>
                <div className="product-image">
                  {p.badge && (
                    <span className={`badge ${p.badge==="BEST VALUE"?"gold":p.badge==="NEW"?"new":p.badge==="BUNDLE"?"bundle":""}`}>
                      {p.badge}
                    </span>
                  )}
                  {p.image ? (
                    <img src={p.image} alt={p.name} loading="lazy" />
                  ) : (
                    <div className="image-placeholder">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                      </svg>
                      <span>Product Image</span>
                    </div>
                  )}
                </div>
                <div className="product-info">
                  <div className="product-name">{p.name}</div>
                  <div
                    className="product-short-desc"
                    dangerouslySetInnerHTML={{
                      __html: fixContentLinkRels(
                        xss(
                          p.short_description || p.description || "",
                          cardDescXss
                        )
                      ),
                    }}
                  />
                  <div className="product-footer">
                    <div className="product-price">{formatPrice(p.price)}</div>
                    {(()=>{
                      const inCart=cart.some(i=>i.id===p.id);
                      const hovering=hoveringId===p.id;
                      return(
                      <button
                        className="add-btn"
                        style={{background:inCart?(hovering?"#DC2626":"#16A34A"):"#111111",cursor:inCart&&!hovering?"default":"pointer"}}
                        onMouseEnter={()=>inCart&&setHoveringId(p.id)}
                        onMouseLeave={()=>setHoveringId(null)}
                        onClick={e=>{e.stopPropagation();e.preventDefault();inCart?removeFromCart(p.id):handleAddToCart(p);}}
                      >
                        {inCart?(hovering?"Remove":"Added"):"Add"}
                      </button>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <SiteFooter />
      </div>

    </>
  );
}