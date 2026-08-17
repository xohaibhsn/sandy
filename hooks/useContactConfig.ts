"use client";

import { cmsText, useSiteContent } from "@/hooks/useSiteContent";
import {
  CONTACT_EMAIL,
  PHONE_DISPLAY,
  WHATSAPP_DIGITS,
  WHATSAPP_URL,
} from "@/lib/site";

export type ContactConfigClient = {
  whatsapp: string;
  email: string;
  telegram: string;
  phone: string;
  whatsappUrl: string;
  telegramUrl: string;
};

export function useContactConfig(): ContactConfigClient {
  const sc = useSiteContent();
  const wa = cmsText(sc, "contact_whatsapp", cmsText(sc, "whatsapp_number", WHATSAPP_DIGITS));
  const rawTg = cmsText(sc, "contact_telegram", "");
  const tgHandle = rawTg.replace(/^@/, "");
  return {
    whatsapp: wa,
    email: cmsText(sc, "contact_email", CONTACT_EMAIL),
    telegram: rawTg ? (rawTg.startsWith("@") ? rawTg : `@${tgHandle}`) : "",
    phone: cmsText(sc, "contact_phone", PHONE_DISPLAY),
    whatsappUrl: wa ? `https://wa.me/${wa}` : WHATSAPP_URL,
    telegramUrl: tgHandle ? `https://t.me/${tgHandle}` : "",
  };
}
