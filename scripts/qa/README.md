# Sandy QA tooling (read-only)

Plain Node 18+ ES modules under `scripts/qa/`. Zero npm dependencies (Node built-ins + global `fetch` only). These scripts measure site health, SEO fingerprints, secrets hygiene, and CMS freshness. They change **no** application behaviour.

Run with:

```bash
node scripts/qa/<name>.mjs
```

Default base URL: `https://sandy.com.pk` (override with `--base`).

## Safety rules

- Unauthenticated **HTTP GET only**. No cookies, no auth headers, no POST/PUT/PATCH/DELETE.
- No cache-busting query strings. No following unknown external redirects/links.
- 15 s timeout per request; at least 300 ms between requests (freshness probe uses its own interval).
- User-Agent: `sandy-qa/1.0 (+read-only)`.
- Never log response bodies beyond counts, hashes, and short sanitised extracts (max 80 chars). Never log `Set-Cookie`.
- Scripts never log in to `/sidhu`. The owner performs any CMS edit manually.
- No secrets in source. Pattern markers in `secrets-gate.mjs` are built by concatenation.

## Limits

- **No JS execution** — extraction is from **raw HTML** only (regex / string parsing).
- SEO and text hashes therefore reflect server-rendered HTML, not client-hydrated DOM.
- Request budgets: health-check ≤ 25, page-hash ≤ 30, freshness-probe ≤ 60 per URL.
- After catalog or CMS content **legitimately** changes, **re-take** the `page-hash` baseline. Resolved product/category/blog URLs come from the live sitemap and will shift with the catalog.

On this site, the raw HTML of `/about`, `/contact`, `/terms`, `/privacy-policy`, and `/refund-policy` is expected to show built-in fallback text rather than CMS text. Those page hashes therefore also reveal when CMS content starts reaching raw HTML.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | All checks passed |
| 1 | A check failed |
| 2 | Usage / runtime error |

All scripts support `--self-test` (offline fixtures; no network) and `--json <file>` for machine-readable output.

---

## `health-check.mjs`

Public page + API health (F9).

```bash
node scripts/qa/health-check.mjs [--base <url>] [--json <file>]
node scripts/qa/health-check.mjs --self-test
```

Checks (GET): `/`, `/products`, first category from sitemap (fallback `/category/subscription`), first `/products/*` from sitemap, `/about`, `/contact`, `/faq`, `/blog`, first `/blog/*`, `/terms`, `/privacy-policy`, `/refund-policy`, `/order-tracking`, `/cart` — expect HTTP 200, non-empty `<title>`, and report (non-fatal) when `<h1>` count ≠ 1.

Also: `/api/products` JSON array length ≥ 1; `/sitemap.xml` 200 XML with ≥ 1 `<loc>`; `/robots.txt` 200 text; `/api/admin-orders` and `/api/admin-products` without cookie must be 401 or 403; `/sidhu` 200 or redirect and must not contain order-data markers.

Does **not** call write endpoints (`/api/track`, `/api/orders`, `/api/contact`, uploads).

---

## `page-hash.mjs`

12-page SEO fingerprint + compare.

```bash
node scripts/qa/page-hash.mjs --out baseline.json [--commit <sha>] [--base <url>]
node scripts/qa/page-hash.mjs --compare baseline.json [--base <url>]
node scripts/qa/page-hash.mjs --self-test
```

Targets: `/`, `/products`, first category URL, first product URL, `/about`, `/contact`, `/faq`, `/blog`, first blog post URL, `/terms`, `/privacy-policy`, `/refund-policy` (dynamic URLs resolved from the live sitemap — recorded in the baseline).

Per page from raw HTML: status, final URL, title, meta description, canonical, meta robots, H1 texts, og:title/description/url, hreflang, JSON-LD (parsed, keys sorted), `html[lang]`, normalised visible-text hash.

Computes `seoFingerprintHash` (SHA-256 of canonical JSON of SEO fields), `textHash`, `textLength`. Build noise (`_next/static`, nonces, script/style) is stripped for text hashing.

Compare mode: exit **1** if any `seoFingerprintHash` differs; `textHash` differences are **WARN** only.

**Re-take the baseline** after catalog or CMS content legitimately changes.

---

## `secrets-gate.mjs`

Secret-like pattern scan over git-tracked files (or `--staged`).

```bash
node scripts/qa/secrets-gate.mjs [--staged] [--baseline <file>] [--baseline-out <file>] [--json <file>]
node scripts/qa/secrets-gate.mjs --self-test
```

Patterns: private key blocks, URL-embedded credentials, bearer/basic literals, AWS access key ids, Google API keys, Slack tokens, JWT-shaped strings, and non-trivial assignments to password/secret/token/api_key/db_* names.

Reports **only** file path, line number, pattern id, and match **length**. Never prints matched values or full lines. Skips binaries, lockfiles, `node_modules`.

Baseline mode fails only on new or increased path+pattern counts. Do not commit baseline files from routine runs into the app repo unless intentionally adopted.

---

## `freshness-probe.mjs`

CMS freshness tester — polls until a marker appears (or disappears).

```bash
node scripts/qa/freshness-probe.mjs --marker "<text>" [--expect absent] [--urls "/,/about,/faq"] [--interval 5] [--timeout 300] [--base <url>]
node scripts/qa/freshness-probe.mjs --self-test
```

Also polls public APIs when they return HTTP 200: `/api/site-content?page=all`, `/api/products`, `/api/faqs`, `/api/blog`, `/api/sections?page=home`. Skips non-200 APIs. API rows are diagnostic (a single CMS text edit will not appear in every API); **exit code is based on the `--urls` page targets only**.

Records seconds until first match (or first absent), and whether the marker appears in raw HTML vs API JSON. Minimum interval 3 s; hard cap 60 requests per URL → `NOT-SEEN`.

### CMS freshness test protocol for the owner

1. In `/sidhu`, change one text field to a unique harmless marker such as `QA-<time>`.
2. Start the probe immediately (`--marker` with that exact text).
3. Read the per-URL timing table (HTML vs API JSON).
4. Restore the original text.

The **owner** performs the admin login and the edit. These scripts **never** log in.

---

## `check-runtime-ddl.mjs`

Static guard against schema changes (DDL) in runtime code. It never connects to a database and never reads the network.

```bash
node scripts/qa/check-runtime-ddl.mjs
```

Scans `app/`, `pages/`, `lib/`, `components/`, `hooks/` and root `*.ts` for `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, `DROP TABLE`, `DROP INDEX`, `DROP COLUMN`, `RENAME TABLE` and `TRUNCATE`. It skips `tests/`, `migrations/`, `scripts/`, `node_modules` and `.next`, and ignores comment-only lines. Read-only probes (`SHOW COLUMNS`, `SHOW CREATE TABLE`, `SELECT ... FROM INFORMATION_SCHEMA`) are not DDL and are never flagged.

`runtime-ddl-allowlist.json` is `{ "<file>": <max DDL count> }` and lists the runtime DDL that still exists. **It is now empty (`{}`): no runtime code creates or alters tables, so any DDL in `app/`, `pages/`, `lib/`, `components/` or `hooks/` fails the check.** Exit **1** if a file that is not in the allowlist contains DDL, or if a file's count goes above its allowlisted maximum. Exit **2** if the allowlist cannot be read. Counts that drop are reported as a NOTE: lower the number (or delete the entry) when you remove DDL from a file. Never raise a number to make the check pass; schema changes belong in `migrations/` and are run by the owner by hand.

Output contains only file paths, counts and rule names. It never prints source lines.

---

## `check-evidence-encoding.mjs` (mandatory pre-zip gate — D36)

Byte-level encoding + source-file scan for evidence folders **before** zipping. Node built-ins only.

```bash
node scripts/qa/check-evidence-encoding.mjs <folder> [--fix]
```

Walks `<folder>` recursively. For every `.txt` `.md` `.json` `.log` `.tsv` `.csv` `.patch` `.sql` file, reads **raw bytes** and flags:

- UTF-16LE BOM (`FF FE`)
- UTF-16BE BOM (`FE FF`)
- UTF-8 BOM (`EF BB BF`)
- any `NUL` (`0x00`) byte

Also flags `.js` `.mjs` `.cjs` `.ts` `.tsx` `.py` `.ps1` `.sh` as `SOURCE_IN_EVIDENCE` (must be removed by hand — never shipped in the ZIP).

Prints one line per offender (`rel/path: KIND[,KIND…]`) then totals:

```
SCANNED=…
UTF16=…
UTF8_BOM=…
NUL=…
SOURCE=…
```

Exit **1** if any offender remains; exit **0** only when all totals are 0. A scan that prints zeros while offenders still exist is a gate failure — this script must not false-pass.

`--fix` rewrites UTF-16 / UTF-8-BOM text files to UTF-8 **without** BOM, then rescans. It never touches source files. NUL-only files without a BOM are reported but not auto-rewritten.

**Mandatory:** run this on the artifacts folder (with `--fix` if needed) and ship the full stdout as `encoding-scan.txt` with exit code 0 before creating the evidence ZIP.