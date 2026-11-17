/**
 * SANDY-BATCH-05 Phase 2 — order receipt_path allowlist (no database, no network).
 *
 * assertSafeReceiptUrl accepts ONLY what POST /api/upload-receipt produces:
 *   - https://res.cloudinary.com/<CLOUDINARY_CLOUD_NAME>/.../sandy/receipts/receipt-<uuid>[.ext]
 *     (only when CLOUDINARY_CLOUD_NAME is set)
 *   - /uploads/receipts/<uuid>.<jpg|png|webp|pdf>
 * Everything else must throw UrlValidationError (the checkout route turns that into its existing 400).
 * The route is also driven end to end with a fake pool to prove the 400 and that accepted values get past it.
 *
 * Run: node tests/receipt-path.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.removeAllListeners("warning");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = pathToFileURL(path.join(root, specifier.slice(2))).href;
      return nextResolve(/\.[mc]?[jt]sx?$/.test(target) ? target : `${target}.ts`, context);
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[mc]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
      // directory import (e.g. ../../lib/otp -> lib/otp/index.ts) — same as orders-test-support
      try {
        return nextResolve(`${specifier.replace(/\/$/, "")}/index.ts`, context);
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context);
  },
});

const { assertSafeReceiptUrl, UrlValidationError } = await import(pathToFileURL(path.join(root, "lib/urlValidation.ts")).href);

let assertions = 0;
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};

const ok = (v, m) => {
  assertions += 1;
  assert.ok(v, m);
};

const CLOUD = "phase2-cloud";
const U = () => crypto.randomUUID();
const savedCloud = process.env.CLOUDINARY_CLOUD_NAME;

function accepted(value, label) {
  let out;
  try {
    out = assertSafeReceiptUrl(value);
  } catch (e) {
    assert.fail(`${label}: expected accept, got ${e?.name}`);
  }
  assertions += 1;
  return out;
}
function rejected(value, label) {
  assertions += 1;
  assert.throws(
    () => assertSafeReceiptUrl(value),
    (e) => e instanceof UrlValidationError && e.message === "Invalid URL or path",
    `${label}: expected UrlValidationError`
  );
}

const results = [];
const run = (name, fn) => {
  fn();
  results.push(name);
};

try {
  // ------------------------------------------------------------------ cloud name configured
  process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
  const id = U();

  run("accepts the exact Cloudinary URLs upload-receipt produces", () => {
    for (const url of [
      `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/sandy/receipts/receipt-${id}.png`,
      `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/sandy/receipts/receipt-${id}.jpg`,
      `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.webp`,
      `https://res.cloudinary.com/${CLOUD}/image/upload/sandy/receipts/receipt-${id}`,
      `https://res.cloudinary.com/${CLOUD}/raw/upload/v1700000000/sandy/receipts/receipt-${id}`,
      `https://res.cloudinary.com/${CLOUD}/raw/upload/v1700000000/sandy/receipts/receipt-${id}.pdf`,
    ]) {
      eq(accepted(url, url), url, url);
    }
  });

  run("accepts local /uploads/receipts/<uuid>.<ext>", () => {
    for (const ext of ["jpg", "png", "webp", "pdf"]) {
      const p = `/uploads/receipts/${U()}.${ext}`;
      eq(accepted(p, p), p, p);
    }
  });

  run("empty / whitespace stays empty (receipt is optional)", () => {
    eq(accepted("", "empty"), "");
    eq(accepted("   ", "blank"), "");
  });

  run("rejects other Cloudinary clouds, hosts and folders", () => {
    for (const [label, url] of [
      ["other cloud", `https://res.cloudinary.com/other-cloud/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["cloud as suffix", `https://res.cloudinary.com/${CLOUD}x/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["cloud in path tail only", `https://res.cloudinary.com/evil/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["wrong folder", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/products/receipt-${id}.png`],
      ["receipts not under sandy", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/other/receipts/receipt-${id}.png`],
      ["extra folder before sandy", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/a/sandy/receipts/receipt-${id}.png`],
      ["non-uuid file name", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-abc.png`],
      ["missing receipt- prefix", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/${id}.png`],
      ["bad extension", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.php`],
      ["double extension", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png.php`],
      ["subfolder under receipts", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/x/receipt-${id}.png`],
      ["bad delivery type", `https://res.cloudinary.com/${CLOUD}/video/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["fetch (remote) delivery", `https://res.cloudinary.com/${CLOUD}/image/fetch/v1/sandy/receipts/receipt-${id}.png`],
      ["other cloudinary host", `https://cdn.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["host look-alike", `https://res.cloudinary.com.evil.test/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["userinfo host trick", `https://res.cloudinary.com@evil.test/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["credentials", `https://${["user", ":", "pw", "@"].join("")}res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["custom port", `https://res.cloudinary.com:8443/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["http", `http://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["query string", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png?x=1`],
      ["fragment", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png#x`],
      ["traversal", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/../receipts/receipt-${id}.png`],
      ["encoded traversal", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/%2e%2e/receipt-${id}.png`],
      ["encoded slash", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy%2Freceipts/receipt-${id}.png`],
      ["backslash", `https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy\\receipts/receipt-${id}.png`],
    ]) {
      rejected(url, label);
    }
  });

  run("rejects local paths that are not upload-receipt names", () => {
    for (const [label, p] of [
      ["no uuid", "/uploads/receipts/receipt.png"],
      ["short name", "/uploads/receipts/abc.png"],
      ["uuid without ext", `/uploads/receipts/${U()}`],
      ["bad ext", `/uploads/receipts/${U()}.php`],
      ["svg", `/uploads/receipts/${U()}.svg`],
      ["double ext", `/uploads/receipts/${U()}.png.php`],
      ["upper-case uuid", `/uploads/receipts/${U().toUpperCase()}.png`],
      ["subfolder", `/uploads/receipts/x/${U()}.png`],
      ["other upload folder", `/uploads/products/${U()}.png`],
      ["other root", `/images/${U()}.png`],
      ["traversal", `/uploads/receipts/../receipts/${U()}.png`],
      ["encoded traversal", `/uploads/receipts/%2e%2e/${U()}.png`],
      ["encoded dot", `/uploads/receipts/%2e/${U()}.png`],
      ["encoded slash", `/uploads%2Freceipts/${U()}.png`],
      ["query", `/uploads/receipts/${U()}.png?x=1`],
      ["fragment", `/uploads/receipts/${U()}.png#x`],
      ["backslash", `/uploads\\receipts\\${U()}.png`],
      ["trailing slash", `/uploads/receipts/${U()}.png/`],
      ["double slash", `//uploads/receipts/${U()}.png`],
      ["protocol-relative host", `//evil.test/uploads/receipts/${U()}.png`],
      ["null byte", `/uploads/receipts/${U()}.png\u0000.php`],
      ["newline", `/uploads/receipts/${U()}.png\nx`],
    ]) {
      rejected(p, label);
    }
  });

  run("rejects dangerous schemes, other hosts and junk", () => {
    for (const [label, v] of [
      ["javascript:", "javascript:alert(1)"],
      ["data:", "data:text/html;base64,PHNjcmlwdD4="],
      ["file:", "file:///etc/passwd"],
      ["ftp:", `ftp://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`],
      ["other https host", `https://evil.test/uploads/receipts/${U()}.png`],
      ["site-relative word", "receipts/receipt.png"],
      ["bare host", "res.cloudinary.com"],
      ["just a slash", "/"],
      ["junk", "not a url"],
    ]) {
      rejected(v, label);
    }
    for (const v of [null, undefined, 5, {}, [], true]) rejected(v, `non-string ${JSON.stringify(v)}`);
    rejected(`/uploads/receipts/${U()}.png${"a".repeat(2100)}`, "over 2048 chars");
  });

  // ------------------------------------------------------------------ cloud name NOT configured
  run("without CLOUDINARY_CLOUD_NAME only the local form is accepted", () => {
    for (const unset of [undefined, "", "   "]) {
      if (unset === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
      else process.env.CLOUDINARY_CLOUD_NAME = unset;
      const local = `/uploads/receipts/${U()}.pdf`;
      eq(accepted(local, "local still ok"), local);
      rejected(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`, "cloud url refused");
      rejected(`https://res.cloudinary.com/demo/image/upload/v1/sandy/receipts/receipt-${id}.png`, "any cloud url refused");
    }
  });

  run("a cloud name containing regex characters is matched literally", () => {
    process.env.CLOUDINARY_CLOUD_NAME = "a.b";
    const ok1 = `https://res.cloudinary.com/a.b/image/upload/v1/sandy/receipts/receipt-${id}.png`;
    eq(accepted(ok1, "literal dot"), ok1);
    rejected(`https://res.cloudinary.com/aXb/image/upload/v1/sandy/receipts/receipt-${id}.png`, "dot is not a wildcard");
    process.env.CLOUDINARY_CLOUD_NAME = ".*";
    rejected(`https://res.cloudinary.com/anything/image/upload/v1/sandy/receipts/receipt-${id}.png`, "pattern chars are not a wildcard");
  });

  // ------------------------------------------------------------------ route level (fake pool; validation runs before any query)
  process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
  let queries = 0;
  globalThis._mysqlPool = {
    query: async () => {
      queries += 1;
      throw new Error("stop after validation");
    },
    getConnection: async () => {
      throw new Error("stop after validation");
    },
  };
  const { __rateLimitTestUtils } = await import(pathToFileURL(path.join(root, "lib/rateLimit.ts")).href);
  const orders = (await import(pathToFileURL(path.join(root, "pages/api/orders.ts")).href)).default;

  async function post(receipt_path) {
    __rateLimitTestUtils.clearStore();
    const res = {
      statusCode: 200,
      body: undefined,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
    };
    await orders(
      {
        method: "POST",
        url: "/api/orders",
        query: {},
        headers: { host: "orders.test", "x-forwarded-for": "203.0.113.77" },
        cookies: {},
        socket: { remoteAddress: "127.0.0.1" },
        body: {
          customer_name: "Test",
          customer_email: "t@example.test",
          customer_phone: "03331234567",
          delivery_address: "Addr",
          city: "Lahore",
          postcode: "54000",
          payment_method: "bank",
          receipt_path,
          items: [{ id: 1, qty: 1 }],
          idempotency_key: crypto.randomUUID(),
        },
      },
      res
    );
    return res;
  }

  await (async () => {
    const bad = await post("https://evil.test/receipt.png");
    eq(bad.statusCode, 400);
    eq(bad.body, { error: "Invalid receipt reference" });
    const badLocal = await post("/uploads/receipts/../../etc/passwd");
    eq(badLocal.statusCode, 400);
    eq(badLocal.body, { error: "Invalid receipt reference" });
    const wrongCloud = await post(`https://res.cloudinary.com/other/image/upload/v1/sandy/receipts/receipt-${id}.png`);
    eq(wrongCloud.statusCode, 400);
    eq(wrongCloud.body, { error: "Invalid receipt reference" });
    eq(queries, 0, "rejected receipts never reach the database");

    const good = await post(`/uploads/receipts/${U()}.png`);
    ok(good.statusCode !== 400 || good.body?.error !== "Invalid receipt reference", "valid local receipt gets past validation");
    const goodCloud = await post(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/sandy/receipts/receipt-${id}.png`);
    ok(goodCloud.body?.error !== "Invalid receipt reference", "valid cloud receipt gets past validation");
    ok(queries > 0, "accepted receipts proceed to the checkout logic");
    results.push("POST /api/orders: bad receipt => existing 400 before any DB access; good receipts proceed");
  })();
} finally {
  if (savedCloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
  else process.env.CLOUDINARY_CLOUD_NAME = savedCloud;
}

console.log(`receipt-path: OK ${results.length} sections, ${assertions} assertions`);
for (const r of results) console.log(`  - ${r}`);
