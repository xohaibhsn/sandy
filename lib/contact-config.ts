import pool from "@/lib/db";
import {
  CONTACT_EMAIL,
  PHONE_DISPLAY,
  WHATSAPP_DIGITS,
  WHATSAPP_URL,
} from "@/lib/site";

export type ContactConfig = {
  whatsapp: string;
  email: string;
  telegram: string;
  phone: string;
  whatsappUrl: string;
  telegramUrl: string;
};

const FALLBACK: ContactConfig = {
  whatsapp: WHATSAPP_DIGITS,
  email: CONTACT_EMAIL,
  telegram: "",
  phone: PHONE_DISPLAY,
  whatsappUrl: WHATSAPP_URL,
  telegramUrl: "",
};

export async function getContactConfig(): Promise<ContactConfig> {
  try {
    const [rows]: any = await pool.query(
      `SELECT content_key, content_value
       FROM site_content
       WHERE content_key IN (
         'contact_whatsapp',
         'whatsapp_number',
         'contact_email',
         'contact_telegram',
         'contact_phone'
       )`
    );

    const config: Record<string, string> = {};
    for (const row of rows || []) {
      config[row.content_key] = row.content_value || "";
    }

    const whatsapp =
      config.contact_whatsapp || config.whatsapp_number || FALLBACK.whatsapp;
    const telegram = (config.contact_telegram || "").trim();
    const telegramHandle = telegram.replace(/^@/, "");

    return {
      whatsapp,
      email: config.contact_email || FALLBACK.email,
      telegram: telegram ? (telegram.startsWith("@") ? telegram : `@${telegramHandle}`) : "",
      phone: config.contact_phone || FALLBACK.phone,
      whatsappUrl: `https://wa.me/${whatsapp}`,
      telegramUrl: telegramHandle ? `https://t.me/${telegramHandle}` : "",
    };
  } catch {
    return { ...FALLBACK };
  }
}
