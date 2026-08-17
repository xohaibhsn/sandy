"use client";

import { useEffect, useState } from "react";
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

const FALLBACK: ContactConfigClient = {
  whatsapp: WHATSAPP_DIGITS,
  email: CONTACT_EMAIL,
  telegram: "",
  phone: PHONE_DISPLAY,
  whatsappUrl: WHATSAPP_URL,
  telegramUrl: "",
};

export function useContactConfig(): ContactConfigClient {
  const [config, setConfig] = useState<ContactConfigClient>(FALLBACK);

  useEffect(() => {
    fetch("/api/site-content?page=all")
      .then((r) => r.json())
      .then((data) => {
        if (!data || typeof data !== "object") return;
        const wa = data.contact_whatsapp || data.whatsapp_number || FALLBACK.whatsapp;
        const rawTg = String(data.contact_telegram || "").trim();
        const tgHandle = rawTg.replace(/^@/, "");
        setConfig({
          whatsapp: wa,
          email: data.contact_email || FALLBACK.email,
          telegram: rawTg ? (rawTg.startsWith("@") ? rawTg : `@${tgHandle}`) : "",
          phone: data.contact_phone || FALLBACK.phone,
          whatsappUrl: `https://wa.me/${wa}`,
          telegramUrl: tgHandle ? `https://t.me/${tgHandle}` : "",
        });
      })
      .catch(() => {});
  }, []);

  return config;
}
