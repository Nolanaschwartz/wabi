export type ErrorHandler = (status: number, body: string) => void;

/**
 * Fetch a URL and return parsed JSON on success.
 * On non-OK responses, calls the error handler with the status and body truncated to 200 chars.
 */
export async function safeFetch<T = unknown>(
  url: string,
  options?: RequestInit,
  onError?: ErrorHandler,
): Promise<T | null> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    onError?.(res.status, body.slice(0, 200));
    return null;
  }
  return res.json() as Promise<T>;
}
