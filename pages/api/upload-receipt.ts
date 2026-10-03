import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import { rateLimit, getClientIp } from '../../lib/rateLimit';
import { assertSafeReceiptUrl, UrlValidationError } from '../../lib/urlValidation';

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } },
};

const RECEIPT_FOLDER = 'sandy/receipts';
const MAX_DECODED_BYTES = 5 * 1024 * 1024;
const RATE_LIMIT = 12;
const RATE_WINDOW_MS = 15 * 60 * 1000;

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

function parseDataUrl(file: unknown): { mime: string; base64: string; dataUrl: string } | null {
  if (typeof file !== 'string' || !file) return null;
  const match = file.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) return null;
  const mime = match[1].trim().toLowerCase();
  const base64 = match[2];
  if (!mime || !base64) return null;
  return { mime, base64, dataUrl: file };
}

function sanitizeFileName(name: unknown): string {
  const raw = typeof name === 'string' && name.trim() ? name.trim() : 'receipt';
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'receipt';
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { allowed } = rateLimit(`receipt-upload:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const parsed = parseDataUrl((body as { file?: unknown }).file);
    if (!parsed || !ALLOWED_MIME.has(parsed.mime)) {
      return res.status(400).json({ error: 'Invalid receipt file' });
    }

    let decoded: Buffer;
    try {
      decoded = Buffer.from(parsed.base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'Invalid receipt file' });
    }
    if (!decoded.length || decoded.length > MAX_DECODED_BYTES) {
      return res.status(400).json({ error: 'Invalid receipt file' });
    }

    const safeName = sanitizeFileName((body as { name?: unknown }).name);
    const isPdf = parsed.mime === 'application/pdf';
    let storedPath = '';

    if (
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    ) {
      const cloudinary = (await import('../../lib/cloudinary')).default;
      const uploadOptions: Record<string, unknown> = {
        folder: RECEIPT_FOLDER,
        public_id: `receipt-${Date.now()}`,
        resource_type: isPdf ? 'raw' : 'image',
      };
      if (!isPdf) {
        uploadOptions.transformation = [{ quality: 90 }];
      }

      const result = await cloudinary.uploader.upload(parsed.dataUrl, uploadOptions);
      storedPath = typeof result.secure_url === 'string' ? result.secure_url : '';
    } else {
      // Local/dev fallback only — restricted to public/uploads/receipts
      const uploadsDir = path.join(process.cwd(), 'public', 'uploads', 'receipts');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      const ext = path.extname(safeName) || extensionForMime(parsed.mime);
      const base = path.basename(safeName, path.extname(safeName)) || 'receipt';
      const fileName = `${Date.now()}-${base}${ext}`;
      fs.writeFileSync(path.join(uploadsDir, fileName), decoded);
      storedPath = `/uploads/receipts/${fileName}`;
    }

    let safePath = '';
    try {
      safePath = assertSafeReceiptUrl(storedPath);
    } catch (err) {
      if (err instanceof UrlValidationError) {
        return res.status(500).json({ error: 'Unable to upload receipt' });
      }
      throw err;
    }
    if (!safePath) {
      return res.status(500).json({ error: 'Unable to upload receipt' });
    }

    return res.status(200).json({ path: safePath });
  } catch {
    return res.status(500).json({ error: 'Unable to upload receipt' });
  }
}
