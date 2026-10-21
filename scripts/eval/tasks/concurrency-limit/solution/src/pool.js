/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once, and resolves to the results in the same
 * order as `items`. If any call rejects, the returned promise rejects with that error.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
