/**
 * Finding 65/66 — admin-receipt signer args: images pass format; raw/PDF omit format.
 * Injected signer only — no network / Cloudinary.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();

if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_SHA256 && !process.env.ADMIN_PASSWORD_HASH) {
  process.env.ADMIN_PASSWORD = "SignerTestMasterLocalOnly";
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = "a".repeat(64);
const orders = new Map<string, { receipt_path: string }>();

(globalThis as unknown as { _mysqlPool: unknown })._mysqlPool = {
  query: async (sql: unknown, params: unknown[] = []) => {
    const text = String(sql);
    if (/FROM admin_sessions/i.test(text) && /SELECT/i.test(text)) {
      return [[{ id: 1, staff_id: null, is_master: 1, role: "manager", name: "signer-test" }], []];
    }
    if (/FROM orders/i.test(text) && /SELECT/i.test(text)) {
      const id = String(params[0] || "");
      const row = orders.get(id);
      return [row ? [{ order_id: id, receipt_path: row.receipt_path, advance_receipt_path: null }] : [], []];
    }
    if (/INSERT INTO admin_audit_log/i.test(text)) return [{ affectedRows: 1 }, []];
    if (/INFORMATION_SCHEMA/i.test(text)) return [[{ c: 1 }], []];
    return [[], []];
  },
  getConnection: async () => {
    throw new Error("no connection");
  },
};

const mod = await import(pathToFileURL(path.join(root, "pages/api/admin-receipt/[file].ts")).href);
const receiptHandler = mod.default;
const { __setReceiptProxyDepsForTests, __clearReceiptProxyRateLimitForTests } = mod;

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
    end(b?: unknown) {
      if (b !== undefined) this.body = b;
      return this;
    },
  };
}

async function getReceipt(orderId: string, ext: string) {
  __clearReceiptProxyRateLimitForTests();
  const res = makeRes();
  const file = `${orderId}.${ext}`;
  await receiptHandler(
    {
      method: "GET",
      url: `/api/admin-receipt/${file}`,
      query: { file },
      headers: { host: "signer.test", "x-forwarded-for": "203.0.113.9" },
      cookies: { sAdminSession: token },
      body: undefined,
      socket: { remoteAddress: "127.0.0.1" },
    } as never,
    res as never
  );
  return res;
}

describe("admin-receipt signer args (F65)", () => {
  after(() => {
    __setReceiptProxyDepsForTests(null);
  });

  it("png image passes format; pdf raw omits format", async () => {
    const calls: Array<Record<string, unknown>> = [];
    __setReceiptProxyDepsForTests({
      signUrl: async (args: {
        publicId: string;
        resourceType: "image" | "raw";
        format?: string;
      }) => {
        calls.push({ ...args });
        const fmt = args.format ? `.${args.format}` : "";
        return `https://res.cloudinary.com/test/image/authenticated/s--X--/v1/${args.publicId}${fmt}`;
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/octet-stream" },
        arrayBuffer: async () => Buffer.from("BYTES"),
      }),
    });

    const pngId = "ORD-SIGN-PNG";
    const pdfId = "ORD-SIGN-PDF";
    const pngUuid = crypto.randomUUID();
    const pdfUuid = crypto.randomUUID();
    orders.set(pngId, { receipt_path: `rcpt:v1:cld:receipt-${pngUuid}.png` });
    orders.set(pdfId, { receipt_path: `rcpt:v1:cld:receipt-${pdfUuid}.pdf` });

    const pngRes = await getReceipt(pngId, "png");
    assert.equal(pngRes.statusCode, 200);
    assert.equal(pngRes.headers["content-type"], "image/png");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].resourceType, "image");
    assert.equal(calls[0].format, "png");
    assert.equal(calls[0].publicId, `sandy/receipts/receipt-${pngUuid}`);

    const pdfRes = await getReceipt(pdfId, "pdf");
    assert.equal(pdfRes.statusCode, 200);
    assert.equal(pdfRes.headers["content-type"], "application/pdf");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].resourceType, "raw");
    assert.equal(calls[1].format, undefined);
    assert.equal(calls[1].publicId, `sandy/receipts/receipt-${pdfUuid}`);
  });
});
