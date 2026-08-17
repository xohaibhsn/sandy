import pool from './db';

let productsReady = false;
let shopReady = false;
let productsInFlight: Promise<void> | null = null;
let shopInFlight: Promise<void> | null = null;

async function addColumn(sql: string) {
  try {
    await pool.query(sql);
  } catch {
    // Column/index already exists, or table was just created with it.
  }
}

async function backfillProductSlugs() {
  try {
    await pool.query(
      `UPDATE products
       SET slug = LOWER(REPLACE(REPLACE(REPLACE(name, ' ', '-'), '/', ''), '--', '-'))
       WHERE slug IS NULL OR slug = ''`
    );
    await pool.query(
      `UPDATE products
       SET slug = TRIM(BOTH '-' FROM slug)
       WHERE slug IS NOT NULL`
    );
  } catch {
    // ignore
  }

  try {
    const [rows]: any = await pool.query(
      `SELECT slug, GROUP_CONCAT(id ORDER BY id) AS ids, COUNT(*) AS c
       FROM products
       WHERE slug IS NOT NULL AND slug != ''
       GROUP BY slug
       HAVING c > 1`
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const ids = String(row.ids || '')
        .split(',')
        .map((id: string) => Number(id))
        .filter(Boolean);
      for (const id of ids.slice(1)) {
        await pool.query('UPDATE products SET slug = ? WHERE id = ?', [`${row.slug}-${id}`, id]);
      }
    }
  } catch {
    // ignore
  }

  await addColumn('ALTER TABLE products ADD UNIQUE KEY unique_slug (slug)');
}

async function activateAllProducts() {
  try {
    await pool.query('UPDATE products SET active=1 WHERE active IS NULL OR active=0');
  } catch {
    // ignore
  }
}

async function seedCatalogIfEmpty() {
  try {
    const [countRows]: any = await pool.query('SELECT COUNT(*) AS c FROM products');
    const count = Number(countRows?.[0]?.c || 0);
    if (count > 0) return;

    await pool.query(
      `INSERT INTO products
        (name, slug, description, short_description, price, category, stock, active)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, 1),
        (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        'Phone Case',
        'phone-case',
        'Protective phone case.',
        'Protective phone case.',
        999,
        'Accessories',
        '24',
        'Wireless Earbuds',
        'wireless-earbuds',
        'Wireless earbuds.',
        'Wireless earbuds.',
        4999,
        'Gadgets',
        '12',
      ]
    );
  } catch {
    // Unique slug / concurrent first-boot — ignore
  }
}

async function ensureProductsOnce() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255),
      description TEXT,
      short_description TEXT,
      full_description TEXT,
      price DECIMAL(10,2) DEFAULT 0,
      category VARCHAR(100),
      badge VARCHAR(100),
      image VARCHAR(500),
      stock VARCHAR(100) DEFAULT 'In Stock',
      features TEXT,
      seo_title VARCHAR(60),
      meta_description VARCHAR(160),
      focus_keyword VARCHAR(100),
      og_image VARCHAR(500),
      active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const sql of [
    'ALTER TABLE products ADD COLUMN slug VARCHAR(255)',
    'ALTER TABLE products ADD COLUMN short_description TEXT',
    'ALTER TABLE products ADD COLUMN full_description TEXT',
    'ALTER TABLE products ADD COLUMN seo_title VARCHAR(60)',
    'ALTER TABLE products ADD COLUMN meta_description VARCHAR(160)',
    'ALTER TABLE products ADD COLUMN focus_keyword VARCHAR(100)',
    'ALTER TABLE products ADD COLUMN features TEXT',
    'ALTER TABLE products ADD COLUMN og_image VARCHAR(500)',
    'ALTER TABLE products ADD COLUMN active TINYINT(1) DEFAULT 1',
    'ALTER TABLE products ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
    'ALTER TABLE products ADD COLUMN stock VARCHAR(100) DEFAULT \'In Stock\'',
    'ALTER TABLE products ADD COLUMN badge VARCHAR(100)',
    'ALTER TABLE products ADD COLUMN image VARCHAR(500)',
    'ALTER TABLE products ADD COLUMN category VARCHAR(100)',
    'ALTER TABLE products ADD COLUMN description TEXT',
    'ALTER TABLE products ADD COLUMN price DECIMAL(10,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN name VARCHAR(255) NOT NULL',
  ]) {
    await addColumn(sql);
  }

  await backfillProductSlugs();
  await activateAllProducts();
  await seedCatalogIfEmpty();
  productsReady = true;
}

async function ensureOrdersOnce() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(50) UNIQUE NOT NULL,
      customer_name VARCHAR(255),
      customer_email VARCHAR(255),
      customer_phone VARCHAR(50),
      delivery_address TEXT,
      city VARCHAR(100),
      postcode VARCHAR(100),
      notes TEXT,
      payment_method VARCHAR(50) DEFAULT 'cod',
      receipt_path VARCHAR(500),
      payment_reference VARCHAR(255),
      total DECIMAL(10,2) DEFAULT 0,
      coupon_code VARCHAR(50),
      discount_amount DECIMAL(10,2) DEFAULT 0,
      vat_amount DECIMAL(10,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(50) NOT NULL,
      product_id INT,
      product_name VARCHAR(255),
      price DECIMAL(10,2),
      quantity INT DEFAULT 1
    )
  `);

  for (const sql of [
    'ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(50)',
    'ALTER TABLE orders ADD COLUMN discount_amount DECIMAL(10,2) DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN vat_amount DECIMAL(10,2) DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN payment_reference VARCHAR(255)',
    "ALTER TABLE orders MODIFY COLUMN payment_method VARCHAR(50) DEFAULT 'cod'",
    'ALTER TABLE orders ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
    'ALTER TABLE orders ADD COLUMN status VARCHAR(50) DEFAULT \'pending\'',
  ]) {
    await addColumn(sql);
  }

  shopReady = true;
}

/** Products table only — public catalog must not depend on orders schema. */
export async function ensureProductsTable(): Promise<void> {
  if (productsReady) return;
  if (!productsInFlight) {
    productsInFlight = ensureProductsOnce().finally(() => {
      productsInFlight = null;
    });
  }
  await productsInFlight;
}

/** Creates shop tables/columns on first use. Safe to call on every request. */
export async function ensureShopTables(): Promise<void> {
  await ensureProductsTable();
  if (shopReady) return;
  if (!shopInFlight) {
    shopInFlight = ensureOrdersOnce()
      .catch((err) => {
        console.error('[ensureShopTables] orders schema', err?.message || err);
      })
      .finally(() => {
        shopInFlight = null;
      });
  }
  await shopInFlight;
}
