import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import pool from '@/lib/db';
import { RL_GENERAL, getClientIp } from '@/lib/rateLimit';
import { getContactConfig } from '@/lib/contact-config';
import { CONTACT_EMAIL, ORDERS_FROM_EMAIL, SITE_NAME, SITE_URL } from '@/lib/site';

function buildSystemPrompt(whatsappDisplay: string) {
  return `Your name is Berlin. You are a friendly sales and support assistant for ${SITE_NAME} (${SITE_URL.replace(/^https?:\/\//, '')}) — a Pakistani online store selling accessories, gadgets and general products.

STORE:
- Based in Lahore, Pakistan
- Delivers nationwide
- Launching with accessories first; more categories over time
- Do not invent prices. Direct customers to the website product pages for current prices.

PAYMENT:
- Cash on Delivery (COD) is available and is the default at checkout
- JazzCash, Easypaisa and bank transfer are also available
- Account numbers are shared after the order is placed
- Never share UK bank details, Revolut, or sort codes

DELIVERY:
- Physical products delivered across Pakistan
- Typical delivery 2–5 working days depending on city
- Shipping is currently free

CONTACT:
- WhatsApp: ${whatsappDisplay}

BEHAVIOUR RULES:
- Plain, helpful English
- Introduce yourself as Berlin
- Do not talk about Firestick, IPTV, streaming subscriptions, or UK services
- Collect name + WhatsApp BEFORE sharing payment details
- Say: 'Before I share payment details, could I get your name and WhatsApp number so we can confirm your order?'
- Complex issues → WhatsApp: ${whatsappDisplay}

LEAD CAPTURE:
- Once you have customer name + WhatsApp: add [LEAD_CAPTURED:name:number:interest] at END of your response
- Example: [LEAD_CAPTURED:Ahmed:03334800181:phone accessories]`;
}

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

async function ensureChatLeadsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_leads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_name VARCHAR(255),
      customer_whatsapp VARCHAR(50),
      customer_email VARCHAR(255),
      interested_in VARCHAR(255),
      chat_history TEXT,
      ip_address VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function ensureBerlinTrainingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS berlin_training (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

async function getBerlinTrainingPrompt() {
  await ensureBerlinTrainingTable();
  const [rows] = await pool.query(
    'SELECT title, content FROM berlin_training WHERE is_active=1 ORDER BY updated_at DESC, id DESC LIMIT 25'
  );
  if (!Array.isArray(rows) || rows.length === 0) return '';

  const training = rows
    .map((row) => {
      const item = row as { title?: string; content?: string };
      return `### ${item.title || 'Training note'}\n${item.content || ''}`;
    })
    .join('\n\n');

  return `\n\nADMIN BERLIN TRAINING KNOWLEDGE:\nUse these admin-added instructions as the latest source of truth. If they conflict with earlier instructions, follow these training notes.\n\n${training}`;
}

function normaliseHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];

  return history
    .map((item) => {
      const candidate = item as { role?: unknown; content?: unknown };
      return {
        role: candidate.role === 'assistant' ? 'assistant' : candidate.role === 'user' ? 'user' : null,
        content: typeof candidate.content === 'string' ? candidate.content.trim() : '',
      };
    })
    .filter((item): item is ChatMessage => !!item.role && item.content.length > 0)
    .slice(-20);
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : '';
    })
    .join('\n')
    .trim();
}

function extractLead(responseText: string) {
  const match = responseText.match(/\s*\[LEAD_CAPTURED:([^:\]]+):([^:\]]+):([^\]]*)\]\s*$/);
  if (!match) return null;

  return {
    name: match[1].trim(),
    whatsapp: match[2].trim(),
    interest: match[3].trim() || 'Not specified',
    cleanResponse: responseText.replace(match[0], '').trim(),
  };
}

async function sendLeadEmail(params: {
  name: string;
  whatsapp: string;
  interest: string;
  timestamp: string;
  chatHistory: string;
}) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"Berlin | ${SITE_NAME}" <${ORDERS_FROM_EMAIL}>`,
    to: CONTACT_EMAIL,
    subject: `🔔 New Lead — ${params.name} | ${SITE_NAME}`,
    text: `Hi,

New lead from Berlin Chat!

👤 Name: ${params.name}
📱 WhatsApp: ${params.whatsapp}
💡 Interested in: ${params.interest}
🕐 Time: ${params.timestamp}

Chat History:
${params.chatHistory}

— Berlin | ${SITE_URL.replace(/^https?:\/\//, '')}`,
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { allowed } = RL_GENERAL(getClientIp(req));
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  try {
    await ensureChatLeadsTable();

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Message is required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Chat is not configured' });

    const history = normaliseHistory(req.body?.history);
    const messages: ChatMessage[] = [...history, { role: 'user', content: message }];
    const trainingPrompt = await getBerlinTrainingPrompt();
    const contact = await getContactConfig();
    const whatsappDisplay = contact.phone.startsWith('+') ? contact.phone : `+${contact.whatsapp}`;
    const systemPrompt = buildSystemPrompt(whatsappDisplay);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const completion = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      max_tokens: 700,
      system: `${systemPrompt}${trainingPrompt}`,
      messages,
    });

    const rawReply = extractText(completion.content);
    const lead = extractLead(rawReply);
    const cleanReply = lead?.cleanResponse || rawReply;
    const fullChatHistory = [...messages, { role: 'assistant' as const, content: cleanReply }]
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Berlin'}: ${m.content}`)
      .join('\n\n');

    const timestamp = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
    const leadName = lead?.name || 'Website visitor';
    const leadWhatsapp = lead?.whatsapp || 'Not provided';
    const leadInterest = lead?.interest || 'General chat enquiry';

    await pool.query(
      'INSERT INTO chat_leads (customer_name, customer_whatsapp, customer_email, interested_in, chat_history, ip_address) VALUES (?,?,?,?,?,?)',
      [leadName, leadWhatsapp, null, leadInterest, fullChatHistory, getClientIp(req)]
    );
    await sendLeadEmail({
      name: leadName,
      whatsapp: leadWhatsapp,
      interest: leadInterest,
      timestamp,
      chatHistory: fullChatHistory,
    }).catch((err: unknown) => console.error('[chat] Lead email failed:', err));

    return res.status(200).json({ response: cleanReply });
  } catch (error: unknown) {
    console.error('[chat] API error:', error);
    return res.status(500).json({ error: 'Chat request failed' });
  }
}
