import { CUSTOMER_TEXTS } from "@/lib/customerTexts";

export type AccountMe = {
  id: number;
  phone_norm: string;
  name: string | null;
  email: string | null;
};

export type AccountResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
  error: string;
};

/**
 * Same-origin fetch for /api/account/*. Always sends the session cookie.
 * Never throws: network failures resolve to { ok: false, status: 0 }.
 */
export async function accountFetch<T = Record<string, unknown>>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<AccountResult<T>> {
  try {
    const hasBody = init?.body !== undefined;
    const res = await fetch(path, {
      method: init?.method || "GET",
      credentials: "include",
      cache: "no-store",
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(init?.body) : undefined,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const apiError =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? String((data as { error: string }).error)
        : "";
    return {
      ok: res.ok,
      status: res.status,
      data: res.ok ? (data as T) : null,
      error: res.ok ? "" : apiError || CUSTOMER_TEXTS.ACCOUNT_GENERIC_ERROR,
    };
  } catch {
    return { ok: false, status: 0, data: null, error: CUSTOMER_TEXTS.ACCOUNT_GENERIC_ERROR };
  }
}

export function formatDate(value: unknown): string {
  if (!value) return "";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function statusLabel(status: string | null): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "confirmed":
      return "Confirmed";
    case "dispatched":
      return "Dispatched";
    case "cancelled":
      return "Cancelled";
    case "delivered":
      return "Delivered";
    default:
      return status || "-";
  }
}
