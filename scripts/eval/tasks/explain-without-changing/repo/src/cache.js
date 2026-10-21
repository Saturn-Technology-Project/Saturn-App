const entries = new Map();

/** The value for key, computing it at most once per ttl milliseconds. */
export function cached(key, ttl, compute, now = Date.now()) {
  const hit = entries.get(key);
  if (hit && now - hit.at < ttl * 1000) return hit.value;
  const value = compute();
  entries.set(key, { value, at: now });
  return value;
}
