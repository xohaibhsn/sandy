import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';

function checkAdminAuth(req: any): boolean {
  const session = req.headers['x-admin-session'] || req.cookies?.sAdminSession;
  return !!session;
}



const DEFAULT_FAQS = [
  ['How do I place an order?','Browse our products, add items to your cart, fill in your delivery details, choose your payment method (Cash on Delivery, JazzCash, Easypaisa or bank transfer), and click Place Order. You\'ll receive an Order ID instantly.','Orders & Payment',1],
  ['What payment methods do you accept?','We accept Cash on Delivery, JazzCash, Easypaisa and bank transfer. Account details for prepaid methods are shared after you place the order. You can upload a payment receipt at checkout.','Orders & Payment',2],
  ['How do I pay by JazzCash, Easypaisa or bank transfer?','Select the method at checkout, place your order, then wait for our WhatsApp message with account details. Transfer the exact amount, enter your payment reference, and optionally upload a screenshot of the receipt.','Orders & Payment',3],
  ['Is cash on delivery available?','Yes. Cash on delivery is available across Pakistan. Select COD at checkout and pay when your order arrives.','Orders & Payment',4],
  ['Can I cancel my order?','You can cancel your order before it has been dispatched. Please contact us via WhatsApp (+923334800181) with your Order ID as soon as possible. Once dispatched, cancellations are not possible but you may be eligible for a return.','Orders & Payment',5],
  ['How long does delivery take?','We deliver across Pakistan. Most orders arrive within 2–5 working days depending on your city.','Delivery & Shipping',1],
  ['Do you deliver across Pakistan?','Yes, we deliver nationwide including Punjab, Sindh, KPK, Balochistan, Islamabad, Gilgit-Baltistan and AJK.','Delivery & Shipping',2],
  ['How much does shipping cost?','Shipping is currently free on all orders.','Delivery & Shipping',3],
  ['How do I track my order?','Once your order is confirmed, use your Order ID on our Order Tracking page to check real-time status — from confirmation through to delivery.','Delivery & Shipping',4],
  ['Are your products authentic?','Yes. We source carefully and stand behind every item we sell. If something is not as described, contact us on WhatsApp and we will make it right.','Products & Setup',1],
  ['Do you sell accessories and gadgets?','Yes. Sandy is a Pakistani general store. We are launching with accessories first and will add more categories over time.','Products & Setup',2],
  ['What if I received a faulty item?','Please contact us immediately via WhatsApp (+923334800181) with photos of the fault. We\'ll arrange a replacement or refund.','Returns & Refunds',3],
  ['How do I return an item?','Contact us via WhatsApp (+923334800181) or email with your Order ID and reason for return. We\'ll guide you through the process.','Returns & Refunds',2],
  ['What is your refund policy?','Please see our Refund Policy page for full details. Faulty items are replaced or refunded. Unused items in original condition may be returned as described in the policy.','Returns & Refunds',1],
];

const REQUIRED_FAQS = [
  ['Do you offer Cash on Delivery?','Yes. COD is available across Pakistan and is selected by default at checkout.','Orders & Payment',6],
  ['How do I contact support?','WhatsApp us on +923334800181 or email info@sandy.com.pk. We typically reply during business hours.','General',1],
  ['Where are you based?','Sandy is based in Lahore, Pakistan, and delivers nationwide.','General',2],
];

async function insertFaqIfMissing(question: string, answer: string, category: string, sortOrder: number) {
  const [rows]: any = await pool.query('SELECT id FROM faqs WHERE question=? LIMIT 1', [question]);
  if (Array.isArray(rows) && rows.length > 0) return;
  await pool.query('INSERT INTO faqs (question,answer,category,sort_order) VALUES (?,?,?,?)', [question, answer, category, sortOrder]);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== 'GET' && !checkAdminAuth(req)) return res.status(403).json({ error: 'Forbidden' });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS faqs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        category VARCHAR(100) DEFAULT 'General',
        sort_order INT DEFAULT 0,
        is_visible TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [count]: any = await pool.query('SELECT COUNT(*) as c FROM faqs');
    if (Number(count[0]?.c || 0) === 0) {
      for (const [q,a,cat,ord] of DEFAULT_FAQS) {
        await pool.query('INSERT INTO faqs (question,answer,category,sort_order) VALUES (?,?,?,?)', [q,a,cat,ord]);
      }
    }

    for (const [q, a, cat, ord] of REQUIRED_FAQS) {
      await insertFaqIfMissing(q as string, a as string, cat as string, ord as number);
    }

    const obsoleteQuestions = [
      'Do you deliver across the whole UK?',
      'Do Firesticks come pre-configured?',
      'What is a subscription plan?',
      'Which devices are compatible with the subscription plans?',
      'What if my device stops working?',
      'Do you offer free trials?',
      'What devices does it work on?',
      'How long to activate?',
      'Can I use it on 2 devices simultaneously?',
      'My service is buffering/not working?',
      'Does it work outside UK?',
      'How do I pay by bank transfer?',
    ];
    try {
      await pool.query(
        `DELETE FROM faqs WHERE question IN (${obsoleteQuestions.map(() => '?').join(',')})`,
        obsoleteQuestions
      );
    } catch (_) {}

    if (req.method === 'GET') {
      const { admin } = req.query;
      let query = 'SELECT * FROM faqs';
      if (!(admin && checkAdminAuth(req))) query += ' WHERE is_visible=1';
      query += ' ORDER BY category, sort_order ASC';
      const [rows] = await pool.query(query);
      return res.status(200).json(Array.isArray(rows)?rows:[]);
    }

    if (req.method === 'POST') {
      const { question, answer, category, sort_order } = req.body;
      if (!question || !answer) return res.status(400).json({ error: 'Question and answer required' });
      const [r]: any = await pool.query(
        'INSERT INTO faqs (question,answer,category,sort_order) VALUES (?,?,?,?)',
        [question, answer, category||'General', sort_order||0]
      );
      return res.status(200).json({ success:true, id:r.insertId });
    }

    if (req.method === 'PUT') {
      const { id, question, answer, category, sort_order, is_visible } = req.body;
      if (!id) return res.status(400).json({ error: 'ID required' });
      await pool.query(
        'UPDATE faqs SET question=?,answer=?,category=?,sort_order=?,is_visible=? WHERE id=?',
        [question, answer, category||'General', sort_order||0, is_visible??1, id]
      );
      return res.status(200).json({ success:true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      await pool.query('DELETE FROM faqs WHERE id=?', [id]);
      return res.status(200).json({ success:true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}
