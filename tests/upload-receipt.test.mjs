/**
 * SANDY-BATCH-05 — POST /api/upload-receipt (no database, no network, no real upload).
 *
 * The REAL handler (pages/api/upload-receipt.ts) is invoked with fake req/res objects.
 * fs writes are intercepted and the Cloudinary uploader is replaced by a recorder, so nothing is
 * written to disk and nothing leaves the machine.
 *
 * Covers: GIF rejected, magic bytes must match the declared MIME (before any upload/write),
 * valid JPEG/PNG/WebP/PDF accepted, file names / public_ids are UUIDs only, error bodies stay generic.
 *
 * Run: node tests/upload-receipt.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.removeAllListeners("warning");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[mc]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context);
  },
});

const { __rateLimitTestUtils } = await import(pathToFileURL(path.join(root, "lib/rateLimit.ts")).href);
const cloudinary = (await import(pathToFileURL(path.join(root, "lib/cloudinary.ts")).href)).default;
const handler = (await import(pathToFileURL(path.join(root, "pages/api/upload-receipt.ts")).href)).default;

let assertions = 0;
const eq = (a, b, m) => {
  assertions += 1;
  assert.deepEqual(a, b, m);
};
const ok = (v, m) => {
  assertions += 1;
  assert.ok(v, m);
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(64, 7)]);

const FILES = {
  jpeg: { mime: "image/jpeg", ext: "jpg", bytes: pad([0xff, 0xd8, 0xff, 0xe0]) },
  png: { mime: "image/png", ext: "png", bytes: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  webp: {
    mime: "image/webp",
    ext: "webp",
    bytes: pad([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
  },
  pdf: { mime: "application/pdf", ext: "pdf", bytes: pad(Buffer.from("%PDF-1.4\n")) },
};
const GIF_BYTES = pad(Buffer.from("GIF89a"));

const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

function makeReq(body, { method = "POST" } = {}) {
  return {
    method,
    url: "/api/upload-receipt",
    query: {},
    headers: { host: "receipt.test", "x-forwarded-for": "203.0.113.20" },
    cookies: {},
    body,
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

const CLOUD_ENV = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
const savedEnv = Object.fromEntries(CLOUD_ENV.map((k) => [k, process.env[k]]));
const realUpload = cloudinary.uploader.upload;
const realFs = { existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync };

/**
 * Runs the handler once with recorders for fs and Cloudinary. `cloud` toggles the Cloudinary env.
 * fs is only patched while the handler runs so module loading is never affected.
 */
async function run(body, { cloud = false, method = "POST", uploadImpl } = {}) {
  __rateLimitTestUtils.clearStore();
  for (const k of CLOUD_ENV) {
    if (cloud) process.env[k] = "test-value";
    else delete process.env[k];
  }
  const rec = { writes: [], mkdirs: [], uploads: [] };
  cloudinary.uploader.upload = async (file, options) => {
    rec.uploads.push({ file, options });
    if (uploadImpl) return uploadImpl(file, options);
    return {
      secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${options.folder}/${options.public_id}.png`,
    };
  };
  fs.existsSync = () => false;
  fs.mkdirSync = (dir) => {
    rec.mkdirs.push(String(dir));
  };
  fs.writeFileSync = (file, data) => {
    rec.writes.push({ file: String(file), data });
  };
  const res = makeRes();
  try {
    await handler(makeReq(body, { method }), res);
  } finally {
    fs.existsSync = realFs.existsSync;
    fs.mkdirSync = realFs.mkdirSync;
    fs.writeFileSync = realFs.writeFileSync;
    cloudinary.uploader.upload = realUpload;
  }
  return { res, rec };
}

function expectRejected({ res, rec }, label) {
  eq(res.statusCode, 400, label);
  eq(res.body, { error: "Invalid receipt file" }, label);
  eq(rec.writes.length, 0, `${label}: nothing written`);
  eq(rec.uploads.length, 0, `${label}: nothing uploaded`);
}

let sections = 0;
async function section(name, fn) {
  try {
    await fn();
    sections += 1;
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
}

try {
  await section("GIF is no longer accepted (local and cloud)", async () => {
    for (const cloud of [false, true]) {
      expectRejected(await run({ file: dataUrl("image/gif", GIF_BYTES) }, { cloud }), `gif cloud=${cloud}`);
    }
  });

  await section("declared MIME must match magic bytes, checked before upload/write", async () => {
    for (const cloud of [false, true]) {
      const tag = `cloud=${cloud}`;
      expectRejected(await run({ file: dataUrl("image/png", FILES.jpeg.bytes) }, { cloud }), `png mime + jpeg bytes ${tag}`);
      expectRejected(await run({ file: dataUrl("image/jpeg", FILES.png.bytes) }, { cloud }), `jpeg mime + png bytes ${tag}`);
      expectRejected(await run({ file: dataUrl("image/webp", FILES.jpeg.bytes) }, { cloud }), `webp mime + jpeg bytes ${tag}`);
      expectRejected(await run({ file: dataUrl("application/pdf", FILES.png.bytes) }, { cloud }), `pdf mime + png bytes ${tag}`);
      expectRejected(await run({ file: dataUrl("image/jpeg", GIF_BYTES) }, { cloud }), `jpeg mime + gif bytes ${tag}`);
      // RIFF container that is not WEBP (e.g. WAVE) and a truncated PNG signature
      const wave = pad([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
      expectRejected(await run({ file: dataUrl("image/webp", wave) }, { cloud }), `webp mime + RIFF/WAVE ${tag}`);
      expectRejected(await run({ file: dataUrl("image/png", FILES.png.bytes.subarray(0, 5)) }, { cloud }), `short png ${tag}`);
      expectRejected(await run({ file: dataUrl("image/jpeg", Buffer.from("<?php echo 1; ?>")) }, { cloud }), `script as jpeg ${tag}`);
    }
  });

  await section("other invalid input stays 400", async () => {
    const bad = [
      undefined,
      {},
      { file: 123 },
      { file: "not a data url" },
      { file: "data:text/html;base64,PGgxPg==" },
      { file: "data:image/png;base64," },
    ];
    for (const body of bad) {
      expectRejected(await run(body), JSON.stringify(body));
    }
    const tooBig = Buffer.concat([FILES.jpeg.bytes, Buffer.alloc(5 * 1024 * 1024)]);
    expectRejected(await run({ file: dataUrl("image/jpeg", tooBig) }), "over 5 MB");
  });

  await section("valid files accepted locally with UUID file names", async () => {
    for (const [key, f] of Object.entries(FILES)) {
      // A hostile client-supplied name must have no influence on the stored name.
      const { res, rec } = await run({ file: dataUrl(f.mime, f.bytes), name: "../../evil name.php" });
      eq(res.statusCode, 200, key);
      ok(new RegExp(`^/uploads/receipts/${UUID}\\.${f.ext}$`).test(res.body.path), `${key}: ${res.body.path}`);
      eq(Object.keys(res.body), ["path"], `${key}: response contract`);
      eq(rec.uploads.length, 0, `${key}: no cloud upload in local mode`);
      eq(rec.writes.length, 1, `${key}: exactly one write`);
      const written = rec.writes[0];
      eq(path.basename(written.file), path.basename(res.body.path));
      eq(path.dirname(written.file), path.join(process.cwd(), "public", "uploads", "receipts"));
      ok(Buffer.from(written.data).equals(f.bytes), `${key}: bytes written unchanged`);
      ok(!/evil|php|\d{13}/.test(written.file), `${key}: no user-controlled or timestamp name parts`);
    }
    const a = (await run({ file: dataUrl("image/png", FILES.png.bytes) })).res.body.path;
    const b = (await run({ file: dataUrl("image/png", FILES.png.bytes) })).res.body.path;
    ok(a !== b, "names are unique per upload");
  });

  await section("valid files accepted via Cloudinary with UUID public_id", async () => {
    for (const [key, f] of Object.entries(FILES)) {
      const { res, rec } = await run({ file: dataUrl(f.mime, f.bytes), name: "../../evil.php" }, { cloud: true });
      eq(res.statusCode, 200, key);
      eq(Object.keys(res.body), ["path"], `${key}: response contract`);
      ok(res.body.path.startsWith("https://res.cloudinary.com/"), key);
      eq(rec.writes.length, 0, `${key}: nothing written locally`);
      eq(rec.uploads.length, 1, `${key}: one upload`);
      const { options } = rec.uploads[0];
      ok(new RegExp(`^receipt-${UUID}$`).test(options.public_id), `${key}: public_id ${options.public_id}`);
      eq(options.folder, "sandy/receipts");
      eq(options.resource_type, f.mime === "application/pdf" ? "raw" : "image", `${key}: resource_type`);
    }
  });

  await section("method, rate limit and generic 500s", async () => {
    const get = await run({}, { method: "GET" });
    eq(get.res.statusCode, 405);
    eq(get.res.body, { error: "Method not allowed" });

    __rateLimitTestUtils.clearStore();
    let last;
    for (let i = 1; i <= 13; i += 1) {
      const res = makeRes();
      await handler(makeReq({ file: "nope" }), res);
      last = res;
      if (i <= 12) eq(res.statusCode, 400, `request ${i}`);
    }
    eq(last.statusCode, 429);
    eq(last.body, { error: "Too many requests" });

    const failed = await run(
      { file: dataUrl("image/png", FILES.png.bytes) },
      {
        cloud: true,
        uploadImpl: () => {
          throw new Error("cloudinary api_secret=TOPSECRET at C:\\internal\\path");
        },
      }
    );
    eq(failed.res.statusCode, 500);
    eq(failed.res.body, { error: "Unable to upload receipt" });
    ok(!JSON.stringify(failed.res.body).includes("TOPSECRET"));
  });

  console.log("UPLOAD_RECEIPT_PASS", JSON.stringify({ sections, assertions }));
} finally {
  for (const k of CLOUD_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.existsSync = realFs.existsSync;
  fs.mkdirSync = realFs.mkdirSync;
  fs.writeFileSync = realFs.writeFileSync;
  cloudinary.uploader.upload = realUpload;
}
process.exit(0);
