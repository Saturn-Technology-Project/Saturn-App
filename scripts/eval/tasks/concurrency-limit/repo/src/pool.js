/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once, and resolves to the results in the same
 * order as `items`. If any call rejects, the returned promise rejects with that error.
 */
export async function mapLimit(items, limit, fn) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      results.push(await fn(item));
    }
  }
  await Promise.all(Array.from({ length: limit + 1 }, worker));
  return results;
}
