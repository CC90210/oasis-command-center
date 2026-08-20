/**
 * Fetch JSON without letting the parser speak for the server.
 *
 * `await res.json()` on an empty body throws "Unexpected end of JSON input".
 * That string names the parser, not the fault, and it is what the Automations
 * tab showed operators every time the route behind it died: a gateway timeout,
 * a 502, or any response that ends before writing a body all arrive as an empty
 * string, and the status code is the only thing left carrying meaning.
 *
 * Reading the body as text first keeps that meaning. The caller gets either
 * parsed JSON or an error sentence naming the HTTP status — something a person
 * can act on and an engineer can search for.
 */
export type FetchJsonResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; raw?: string };

/**
 * Which failures are worth trying again.
 *
 * An empty body, a 502/503/504, or a fetch that never reached the server are
 * transient by nature — a cold start, a dropped upstream connection, a database
 * blip. A 4xx is not: retrying an unauthorized or malformed request just asks
 * the same wrong question twice. Retrying only the first group is what turns a
 * blip into a slightly slower load instead of an error banner.
 */
function isTransient(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504 || status >= 520;
}

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { retries?: number; retryDelayMs?: number },
): Promise<FetchJsonResult<T>> {
  const retries = opts?.retries ?? 0;
  const baseDelay = opts?.retryDelayMs ?? 400;

  for (let attempt = 0; ; attempt++) {
    const result = await attemptFetchJson<T>(input, init);
    if (result.ok) return result;
    const retryable = isTransient(result.status) || result.status === 200;
    if (attempt >= retries || !retryable) return result;
    // Linear backoff: 400ms, 800ms, 1200ms. Short enough that a human waiting
    // on a dashboard does not notice, long enough to clear a cold start.
    await new Promise((r) => setTimeout(r, baseDelay * (attempt + 1)));
  }
}

async function attemptFetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<FetchJsonResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e) {
    // Offline, DNS, CORS, aborted — never reached the server at all.
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "network request failed" };
  }

  const raw = await res.text();

  if (!raw.trim()) {
    return {
      ok: false,
      status: res.status,
      error:
        res.status === 504 || res.status === 502
          ? `the server took too long to answer (HTTP ${res.status}) — retrying usually works`
          : `the server returned an empty response (HTTP ${res.status})`,
    };
  }

  try {
    return { ok: true, status: res.status, data: JSON.parse(raw) as T };
  } catch {
    // Non-JSON almost always means a platform error page rather than this
    // route. Keep an excerpt so the two are distinguishable at a glance.
    return {
      ok: false,
      status: res.status,
      error: `the server sent a non-JSON response (HTTP ${res.status})`,
      raw: raw.slice(0, 200),
    };
  }
}
