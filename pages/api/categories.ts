import type { NextApiRequest, NextApiResponse } from "next";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import pool from "../../lib/db";
import { requireAdmin, requireRole } from "../../lib/adminAuth";
import {
  ensureCategoriesTable,
  categorySlugFromName,
} from "../../lib/ensureCategories";
import { assertSafeImageUrl, UrlValidationError } from "../../lib/urlValidation";

const NAME_MAX = 100;
const SLUG_MAX = 120;
const DESCRIPTION_MAX = 5000;
const SORT_MAX = 1_000_000;

type CategoryRow = RowDataPacket & {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
  parent_id: number | null;
  active: number;
  sort_order: number;
  created_at: unknown;
  updated_at: unknown;
};

function badRequest(res: NextApiResponse, error: string) {
  return res.status(400).json({ error });
}

function isDupEntry(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ER_DUP_ENTRY"
  );
}

function parsePositiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function validateName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > NAME_MAX) return null;
  return name;
}

function normalizeSlugInput(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const slug = categorySlugFromName(raw);
  if (!slug || slug.length > SLUG_MAX) return null;
  if (slug !== categorySlugFromName(slug)) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  return slug;
}

/** undefined = omitted; null/string = value; symbol invalid via caller checking undefined from bad type */
function validateDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length > DESCRIPTION_MAX) return undefined;
  return trimmed;
}

function normalizeActive(value: unknown): 0 | 1 | null | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return null;
}

function normalizeSortOrder(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > SORT_MAX) return null;
  return n;
}

function rejectNonNullParent(value: unknown, res: NextApiResponse): boolean {
  if (value === undefined || value === null || value === "") return false;
  badRequest(res, "parent_id is not supported yet");
  return true;
}

async function countProductsUsingCategoryName(name: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM products
     WHERE category IS NOT NULL AND TRIM(category) = ?`,
    [name]
  );
  return Number(rows?.[0]?.c || 0);
}

async function countChildCategories(id: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM categories WHERE parent_id = ?`,
    [id]
  );
  return Number(rows?.[0]?.c || 0);
}

async function getCategoryById(id: number): Promise<CategoryRow | null> {
  const [rows] = await pool.query<CategoryRow[]>(
    `SELECT id, name, slug, description, image, parent_id, active, sort_order, created_at, updated_at
     FROM categories WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows?.[0] || null;
}

function safeImage(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return assertSafeImageUrl(value);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const session = await requireAdmin(req, res);
    if (!session) return;
  } else if (
    req.method === "POST" ||
    req.method === "PUT" ||
    req.method === "DELETE"
  ) {
    const session = await requireRole(req, res, ["super_admin", "manager"]);
    if (!session) return;
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await ensureCategoriesTable();

    if (req.method === "GET") {
      const [rows] = await pool.query<CategoryRow[]>(
        `SELECT id, name, slug, description, image, parent_id, active, sort_order, created_at, updated_at
         FROM categories
         ORDER BY sort_order ASC, name ASC, id ASC`
      );
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    if (req.method === "POST") {
      const body = req.body || {};
      if (rejectNonNullParent(body.parent_id, res)) return;

      const name = validateName(body.name);
      if (!name) return badRequest(res, "Valid name is required (max 100 characters)");

      let slug: string | null;
      if (body.slug === undefined || body.slug === null || body.slug === "") {
        slug = categorySlugFromName(name);
        if (!slug || slug.length > SLUG_MAX) {
          return badRequest(res, "Could not derive a valid slug from name");
        }
      } else {
        slug = normalizeSlugInput(body.slug);
        if (!slug) return badRequest(res, "Valid slug is required (max 120 characters)");
      }

      const description = validateDescription(
        body.description === undefined ? "" : body.description
      );
      if (description === undefined) {
        return badRequest(res, "Invalid description (max 5000 characters)");
      }

      let image = "";
      try {
        image = safeImage(body.image);
      } catch (err) {
        if (err instanceof UrlValidationError) {
          return badRequest(res, "Invalid URL or path");
        }
        throw err;
      }

      const activeNorm = normalizeActive(
        body.active === undefined ? 1 : body.active
      );
      if (activeNorm === null || activeNorm === undefined) {
        return badRequest(res, "active must be 0 or 1");
      }

      const sortNorm = normalizeSortOrder(
        body.sort_order === undefined ? 0 : body.sort_order
      );
      if (sortNorm === null || sortNorm === undefined) {
        return badRequest(res, "sort_order must be an integer from 0 to 1000000");
      }

      try {
        const [result] = await pool.query<ResultSetHeader>(
          `INSERT INTO categories (name, slug, description, image, parent_id, active, sort_order)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          [name, slug, description, image || null, activeNorm, sortNorm]
        );
        return res.status(201).json({
          success: true,
          id: result.insertId,
          name,
          slug,
          active: activeNorm,
          sort_order: sortNorm,
        });
      } catch (err: unknown) {
        if (isDupEntry(err)) {
          return res
            .status(409)
            .json({ error: "Category name or slug already exists" });
        }
        throw err;
      }
    }

    if (req.method === "PUT") {
      const body = req.body || {};
      if (rejectNonNullParent(body.parent_id, res)) return;

      const id = parsePositiveInt(body.id);
      if (!id) return badRequest(res, "Valid category id is required");

      const existing = await getCategoryById(id);
      if (!existing) return res.status(404).json({ error: "Category not found" });

      let nextName = existing.name;
      if (body.name !== undefined) {
        const name = validateName(body.name);
        if (!name) return badRequest(res, "Valid name is required (max 100 characters)");
        nextName = name;
      }

      let nextSlug = existing.slug;
      if (body.slug !== undefined && body.slug !== null && body.slug !== "") {
        const slug = normalizeSlugInput(body.slug);
        if (!slug) return badRequest(res, "Valid slug is required (max 120 characters)");
        nextSlug = slug;
      }

      let nextDescription =
        existing.description === null || existing.description === undefined
          ? null
          : String(existing.description);
      if (body.description !== undefined) {
        const description = validateDescription(body.description);
        if (description === undefined) {
          return badRequest(res, "Invalid description (max 5000 characters)");
        }
        nextDescription = description;
      }

      let nextImage =
        existing.image === null || existing.image === undefined
          ? null
          : String(existing.image);
      if (body.image !== undefined) {
        try {
          const image = safeImage(body.image);
          nextImage = image || null;
        } catch (err) {
          if (err instanceof UrlValidationError) {
            return badRequest(res, "Invalid URL or path");
          }
          throw err;
        }
      }

      let nextActive = existing.active === 0 ? 0 : 1;
      if (body.active !== undefined) {
        const activeNorm = normalizeActive(body.active);
        if (activeNorm === null || activeNorm === undefined) {
          return badRequest(res, "active must be 0 or 1");
        }
        nextActive = activeNorm;
      }

      let nextSort = Number(existing.sort_order) || 0;
      if (body.sort_order !== undefined) {
        const sortNorm = normalizeSortOrder(body.sort_order);
        if (sortNorm === null || sortNorm === undefined) {
          return badRequest(res, "sort_order must be an integer from 0 to 1000000");
        }
        nextSort = sortNorm;
      }

      if (nextName !== existing.name) {
        const refs = await countProductsUsingCategoryName(existing.name);
        if (refs > 0) {
          return res.status(409).json({
            error: "Cannot rename a category while products are assigned to it",
          });
        }
      }

      try {
        const [result] = await pool.query<ResultSetHeader>(
          `UPDATE categories
           SET name=?, slug=?, description=?, image=?, parent_id=NULL, active=?, sort_order=?
           WHERE id=?`,
          [nextName, nextSlug, nextDescription, nextImage, nextActive, nextSort, id]
        );
        if (!result || result.affectedRows === 0) {
          return res.status(404).json({ error: "Category not found" });
        }
        return res.status(200).json({
          success: true,
          id,
          name: nextName,
          slug: nextSlug,
          active: nextActive,
          sort_order: nextSort,
        });
      } catch (err: unknown) {
        if (isDupEntry(err)) {
          return res
            .status(409)
            .json({ error: "Category name or slug already exists" });
        }
        throw err;
      }
    }

    if (req.method === "DELETE") {
      const id = parsePositiveInt(req.query.id);
      if (!id) return badRequest(res, "Valid category id is required");

      const existing = await getCategoryById(id);
      if (!existing) return res.status(404).json({ error: "Category not found" });

      const productRefs = await countProductsUsingCategoryName(existing.name);
      if (productRefs > 0) {
        return res.status(409).json({
          error: "Cannot delete a category while products are assigned to it",
        });
      }

      const childRefs = await countChildCategories(id);
      if (childRefs > 0) {
        return res.status(409).json({
          error: "Cannot delete a category that has child categories",
        });
      }

      const [result] = await pool.query<ResultSetHeader>(
        "DELETE FROM categories WHERE id = ?",
        [id]
      );
      if (!result || result.affectedRows !== 1) {
        return res.status(404).json({ error: "Category not found" });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error: unknown) {
    if (error instanceof UrlValidationError) {
      return badRequest(res, "Invalid URL or path");
    }
    const detail =
      typeof error === "object" && error && ("code" in error || "message" in error)
        ? (error as { code?: string; message?: string }).code ||
          (error as { message?: string }).message
        : error;
    console.error("[api/categories]", detail);
    return res.status(500).json({ error: "Internal server error" });
  }
}
