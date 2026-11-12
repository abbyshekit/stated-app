// INTEGRATION: shared per-app budget for exports and heavy public JSON, before database reads.
import { isIP } from 'node:net';

function canonicalIp(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value;
}

export function clientAddress(req, { railway = false } = {}) {
  // Trust ONLY Railway public HTTP ingress's X-Real-IP, documented at:
  // https://docs.railway.com/networking/public-networking/specs-and-limits
  // Deployment must not expose a direct/private bypass to untrusted callers.
  // Local/non-Railway deployments ignore forwarding headers, including X-Forwarded-For.
  return (railway && canonicalIp(req.headers['x-real-ip'])) || canonicalIp(req.socket?.remoteAddress) || 'unknown';
}

export function createReadLimiter({ railway = false, capacity = 10, refillMs = 6000, maxClients = 4096, now = Date.now } = {}) {
  const clients = new Map();
  return req => {
    const key = clientAddress(req, { railway });
    const at = now();
    let bucket = clients.get(key);
    if (!bucket) {
      if (clients.size >= maxClients) {
        for (const [address, old] of clients) if (at - old.at >= capacity * refillMs) clients.delete(address);
      }
      // Refuse unknown clients when full; eviction must not let an attacker reset an exhausted bucket.
      if (clients.size >= maxClients) return { allowed: false, retryAfter: Math.ceil(capacity * refillMs / 1000) };
      bucket = { tokens: capacity, at };
      clients.set(key, bucket);
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, at - bucket.at) / refillMs);
    bucket.at = at;
    if (bucket.tokens < 1) return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) * refillMs / 1000)) };
    bucket.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  };
}
