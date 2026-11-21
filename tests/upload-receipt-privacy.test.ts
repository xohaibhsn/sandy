/**
 * RECEIPT-PRIVACY-01 — upload-receipt returns opaque refs; local writes outside public/;
 * Cloudinary branch passes type:"authenticated". No network.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

const { __rateLimitTestUtils } = await import("../lib/rateLimit.ts");
const cloudinary = (await import("../lib/cloudinary.ts")).default;
const handler = (await import("../pages/api/upload-receipt.ts")).default;
const { parseReceiptRef } = await import("../lib/receiptRef.ts");

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const pad = (head: number[] | Buffer) =>
  Buffer.concat([Buffer.isBuffer(head) ? head : Buffer.from(head), Buffer.alloc(64, 7)]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const dataUrl = (mime: string, bytes: Buffer) =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

function makeReq(body: unknown) {
  return {
    method: "POST",
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
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

const CLOUD_ENV = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
const savedEnv = Object.fromEntries(CLOUD_ENV.map((k) => [k, process.env[k]]));
const realUpload = cloudinary.uploader.upload;
const realFs = {
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  writeFileSync: fs.writeFileSync,
};

async function run(body: unknown, { cloud = false }: { cloud?: boolean } = {}) {
  __rateLimitTestUtils.clearStore();
  for (const k of CLOUD_ENV) {
    if (cloud) process.env[k] = "test-value";
    else delete process.env[k];
  }
  const rec: { writes: { file: string; data: Buffer }[]; mkdirs: string[]; uploads: unknown[] } = {
    writes: [],
    mkdirs: [],
    uploads: [],
  };
  cloudinary.uploader.upload = (async (file: unknown, options: unknown) => {
    rec.uploads.push({ file, options });
    return {
      secure_url:
        "https://res.cloudinary.com/test-value/image/authenticated/s--FAKE--/v1/sandy/receipts/x.png",
    };
  }) as typeof cloudinary.uploader.upload;
  fs.existsSync = () => false as never;
  fs.mkdirSync = ((dir: fs.PathLike) => {
    rec.mkdirs.push(String(dir));
  }) as typeof fs.mkdirSync;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
    rec.writes.push({ file: String(file), data: Buffer.from(data as Buffer) });
  }) as typeof fs.writeFileSync;
  const res = makeRes();
  try {
    await handler(makeReq(body) as never, res as never);
  } finally {
    fs.existsSync = realFs.existsSync;
    fs.mkdirSync = realFs.mkdirSync;
    fs.writeFileSync = realFs.writeFileSync;
    cloudinary.uploader.upload = realUpload;
  }
  return { res, rec };
}

describe("upload-receipt privacy", () => {
  after(() => {
    for (const k of CLOUD_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    cloudinary.uploader.upload = realUpload;
  });

  it("local mode writes outside public/ and returns loc ref", async () => {
    const { res, rec } = await run({ file: dataUrl("image/png", PNG) });
    assert.equal(res.statusCode, 200);
    const body = res.body as { path: string };
    assert.deepEqual(Object.keys(body), ["path"]);
    const parsed = parseReceiptRef(body.path);
    assert.ok(parsed);
    assert.equal(parsed!.storage, "loc");
    assert.equal(parsed!.ext, "png");
    assert.ok(new RegExp(`^${UUID}$`).test(parsed!.id));
    assert.equal(rec.uploads.length, 0);
    assert.equal(rec.writes.length, 1);
    const written = rec.writes[0].file;
    assert.ok(written.includes(path.join("private-uploads", "receipts")));
    assert.ok(!written.includes(`${path.sep}public${path.sep}`));
    assert.ok(!String(body.path).includes("http"));
    assert.ok(!String(body.path).includes("/uploads/"));
  });

  it("cloudinary branch passes type authenticated and returns only cld ref", async () => {
    const { res, rec } = await run({ file: dataUrl("image/png", PNG) }, { cloud: true });
    assert.equal(res.statusCode, 200);
    const body = res.body as { path: string };
    assert.deepEqual(Object.keys(body), ["path"]);
    const parsed = parseReceiptRef(body.path);
    assert.ok(parsed);
    assert.equal(parsed!.storage, "cld");
    assert.ok(parsed!.id.startsWith("receipt-"));
    assert.equal(rec.uploads.length, 1);
    const opts = (rec.uploads[0] as { options: Record<string, unknown> }).options;
    assert.equal(opts.type, "authenticated");
    assert.equal(opts.folder, "sandy/receipts");
    assert.ok(!String(body.path).includes("cloudinary"));
    assert.ok(!String(body.path).includes("http"));
    assert.ok(!String(body.path).includes("secure_url"));
  });
});
