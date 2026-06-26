import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Per-IP daily cap on the (paid) model calls. It's active ONLY when Upstash is
// configured via env vars — without them (local dev, or a deploy that hasn't
// set them) this is a no-op, so the app still works and nothing breaks. Add a
// free Upstash Redis database and set UPSTASH_REDIS_REST_URL / _TOKEN to turn
// it on; tune the cap with RATELIMIT_PER_DAY.
const PER_DAY = Number(process.env.RATELIMIT_PER_DAY ?? 30);

// `undefined` = not yet resolved; `null` = resolved to "not configured".
let limiter: Ratelimit | null | undefined;

function getLimiter(): Ratelimit | null {
  if (limiter !== undefined) return limiter;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || !Number.isFinite(PER_DAY) || PER_DAY <= 0) {
    limiter = null;
    return null;
  }

  limiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(PER_DAY, "1 d"),
    prefix: "rummage",
    analytics: false,
  });
  return limiter;
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || "anonymous";
  return req.headers.get("x-real-ip") ?? "anonymous";
}

/**
 * Returns { ok: true } when the request is allowed — including when rate
 * limiting isn't configured, or when Redis is unreachable (fail open: a
 * monitoring hiccup shouldn't take the app down).
 */
export async function checkRateLimit(req: Request): Promise<{ ok: boolean; retryAfter?: number }> {
  const rl = getLimiter();
  if (!rl) return { ok: true };

  try {
    const { success, reset } = await rl.limit(clientIp(req));
    if (success) return { ok: true };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) };
  } catch {
    return { ok: true };
  }
}
