import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import { requireAdmin } from '../../lib/adminAuth';

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

const ALLOWED_UPLOAD_FOLDERS = new Set([
  'sandy/products',
  'sandy/logo',
  'sandy/hero-slides',
  'sandy/whatsapp-icon',
  'sandy/og',
  'sandy/receipts',
]);

const DEFAULT_UPLOAD_FOLDER = 'sandy/products';

function resolveUploadFolder(folder: unknown): string | null {
  if (folder === undefined || folder === null || folder === '') {
    return DEFAULT_UPLOAD_FOLDER;
  }
  if (typeof folder !== 'string') return null;
  const trimmed = folder.trim();
  if (!ALLOWED_UPLOAD_FOLDERS.has(trimmed)) return null;
  return trimmed;
}

function assertSafeUploadDataUrl(file: unknown, isReceipt: boolean): string {
  if (typeof file !== 'string' || !file) {
    throw new Error('INVALID_FILE_DATA');
  }
  const imagePrefixOk = file.startsWith('data:image/') && file.includes(';base64,');
  const pdfPrefixOk =
    isReceipt && file.startsWith('data:application/pdf;base64,');
  if (!imagePrefixOk && !pdfPrefixOk) {
    throw new Error('INVALID_FILE_DATA');
  }
  const comma = file.indexOf(',');
  if (comma < 0 || file.slice(comma + 1).length === 0) {
    throw new Error('INVALID_FILE_DATA');
  }
  return file;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const session = await requireAdmin(req, res);
  if (!session) return;

  try {
    const { file, name, folder } = req.body;

    const cloudinaryFolder = resolveUploadFolder(folder);
    if (!cloudinaryFolder) {
      return res.status(400).json({ error: 'Invalid upload folder' });
    }

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const isReceipt = cloudinaryFolder === 'sandy/receipts';
    const isLogo = cloudinaryFolder === 'sandy/logo';
    const isWhatsAppIcon = cloudinaryFolder === 'sandy/whatsapp-icon';
    const isHeroSlide = cloudinaryFolder === 'sandy/hero-slides';
    const isOg = cloudinaryFolder === 'sandy/og';
    const preserveImage = isReceipt || isLogo || isWhatsAppIcon || isHeroSlide || isOg;

    let safeFile: string;
    try {
      safeFile = assertSafeUploadDataUrl(file, isReceipt);
    } catch {
      return res.status(400).json({ error: 'Invalid file data' });
    }

    // Use Cloudinary if credentials are configured
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      const cloudinary = (await import('../../lib/cloudinary')).default;

      const uploadOptions: any = { folder: cloudinaryFolder };

      if (isLogo) {
        // Logo: keep transparency, limit size without square crop / webp force
        uploadOptions.transformation = [
          { width: 800, height: 200, crop: 'limit' },
          { quality: 90 },
        ];
      } else if (isWhatsAppIcon) {
        uploadOptions.transformation = [
          { width: 512, height: 512, crop: 'limit' },
          { quality: 90 },
        ];
      } else if (isOg) {
        // OG share image: keep 1200×630 aspect, no square crop
        uploadOptions.transformation = [
          { width: 1200, height: 630, crop: 'limit' },
          { quality: 90 },
        ];
      } else if (isHeroSlide) {
        uploadOptions.transformation = [
          { width: 1920, height: 1080, crop: 'limit' },
          { quality: 85, fetch_format: 'webp' },
        ];
      } else if (isReceipt) {
        // Receipts: preserve original, no aggressive compression
        uploadOptions.transformation = [{ quality: 90 }];
      } else {
        // Product/blog images: resize + webp
        uploadOptions.transformation = [
          { width: 800, height: 800, crop: 'limit' },
          { quality: 85, fetch_format: 'webp' },
        ];
      }

      const result = await cloudinary.uploader.upload(safeFile, uploadOptions);
      return res.status(200).json({ path: result.secure_url });
    }

    // Fallback: save locally (localhost dev without Cloudinary creds)
    const base64Data = safeFile.replace(/^data:[^;]+;base64,/, '');
    const localSub = isReceipt ? 'receipts' : isLogo ? 'logo' : isWhatsAppIcon ? 'whatsapp' : '';
    const uploadsDir = path.join(process.cwd(), 'public', 'uploads', localSub);
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const safeName = Date.now() + '-' + String(name).replace(/[^a-zA-Z0-9._-]/g, '_');

    if (!preserveImage) {
      try {
        const sharp = require('sharp');
        const inputBuffer = Buffer.from(base64Data, 'base64');
        const webpName = safeName.replace(/\.[^.]+$/, '.webp');
        await sharp(inputBuffer).resize(800, 800, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toFile(path.join(uploadsDir, webpName));
        return res.status(200).json({ path: `/uploads/${webpName}` });
      } catch { /* sharp not available, fall through */ }
    }

    fs.writeFileSync(path.join(uploadsDir, safeName), base64Data, 'base64');
    const sub = localSub ? `${localSub}/` : '';
    return res.status(200).json({ path: `/uploads/${sub}${safeName}` });

  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}
