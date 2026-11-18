import { adminRequest, type AdminRequestResult } from "./adminRequest";

/** Delay before the single retry (finding 49). */
export const DASHBOARD_SUMMARY_RETRY_DELAY_MS = 1500;

/**
 * Retry only transient failures: network error (adminRequest status 0) or HTTP 5xx.
 * Never retry 401/403 (session) or other 4xx (bad range, etc.) or a 2xx with a bad body.
 */
export function isTransientDashboardFailure(res: Pick<AdminRequestResult, "ok" | "status">): boolean {
  if (res.ok) return false;
  return res.status === 0 || (res.status >= 500 && res.status <= 599);
}

type Options = {
  retryDelayMs?: number;
  /** Injectable for tests; defaults to adminRequest. */
  request?: <T>(input: RequestInfo | URL, init?: RequestInit) => Promise<AdminRequestResult<T>>;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** When true after the delay, the retry is skipped (component unmounted / params changed). */
  isCancelled?: () => boolean;
};

/**
 * GET the dashboard summary. On a transient failure, wait ~1.5s and retry exactly ONCE;
 * the caller shows the error banner only with the final result.
 */
export async function fetchDashboardSummaryWithRetry<T = Record<string, unknown>>(
  url: string,
  opts: Options = {}
): Promise<AdminRequestResult<T>> {
  const request = opts.request ?? adminRequest;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const first = await request<T>(url);
  if (!isTransientDashboardFailure(first)) return first;
  await sleep(opts.retryDelayMs ?? DASHBOARD_SUMMARY_RETRY_DELAY_MS);
  if (opts.isCancelled?.()) return first;
  return request<T>(url);
}
