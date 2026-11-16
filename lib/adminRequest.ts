export type AdminRequestResult<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  data: T;
  errorMessage: string;
  sessionExpired: boolean;
};

function safeMessage(raw: unknown, fallback: string): string {
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return fallback;
    // Never surface stack-like or oversized payloads in the admin UI.
    if (t.length > 240) return fallback;
    if (/\nat\s+\S+/.test(t) || t.includes("\\n    at ")) return fallback;
    return t;
  }
  return fallback;
}

function messageFromBody(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const err = (data as { error?: unknown }).error;
    return safeMessage(err, fallback);
  }
  return fallback;
}

/**
 * Admin fetch helper: credentials included, checks HTTP status and optional JSON success flag.
 * 401/403 map to a clear session-expired message (never claimed as success).
 */
export async function adminRequest<T = Record<string, unknown>>(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { expectSuccess?: boolean }
): Promise<AdminRequestResult<T>> {
  const expectSuccess = opts?.expectSuccess !== false;
  try {
    const response = await fetch(input, {
      ...init,
      credentials: init?.credentials ?? "same-origin",
    });
    const status = response.status;
    const sessionExpired = status === 401 || status === 403;
    let data: T = {} as T;
    try {
      data = (await response.json()) as T;
    } catch {
      data = {} as T;
    }

    if (sessionExpired) {
      return {
        ok: false,
        status,
        data,
        errorMessage: "Your session expired. Please sign in again.",
        sessionExpired: true,
      };
    }

    const body = data as { success?: unknown; error?: unknown };
    const successFlagOk =
      !expectSuccess ||
      body?.success === true ||
      body?.success === 1 ||
      body?.success === "true";

    if (!response.ok || !successFlagOk) {
      return {
        ok: false,
        status,
        data,
        errorMessage: messageFromBody(
          data,
          response.ok ? "Request failed" : `Request failed (${status})`
        ),
        sessionExpired: false,
      };
    }

    return {
      ok: true,
      status,
      data,
      errorMessage: "",
      sessionExpired: false,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: {} as T,
      errorMessage: "Network error. Please try again.",
      sessionExpired: false,
    };
  }
}

/** GET helper for list endpoints that return a JSON array (or error object). */
export async function adminFetchList<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<AdminRequestResult<T[]>> {
  try {
    const response = await fetch(input, {
      ...init,
      credentials: init?.credentials ?? "same-origin",
    });
    const status = response.status;
    const sessionExpired = status === 401 || status === 403;
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (sessionExpired) {
      return {
        ok: false,
        status,
        data: [],
        errorMessage: "Your session expired. Please sign in again.",
        sessionExpired: true,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status,
        data: [],
        errorMessage: messageFromBody(data, `Failed to load (${status})`),
        sessionExpired: false,
      };
    }

    if (!Array.isArray(data)) {
      return {
        ok: false,
        status,
        data: [],
        errorMessage: messageFromBody(data, "Unexpected response from server"),
        sessionExpired: false,
      };
    }

    return {
      ok: true,
      status,
      data: data as T[],
      errorMessage: "",
      sessionExpired: false,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: [],
      errorMessage: "Network error. Please try again.",
      sessionExpired: false,
    };
  }
}
