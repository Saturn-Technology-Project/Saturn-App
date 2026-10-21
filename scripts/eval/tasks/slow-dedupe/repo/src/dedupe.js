/** The items with duplicates removed: the first item for each key(item) is kept, in the original order. */
export function uniqueBy(items, key) {
  const out = [];
  for (const item of items) {
    if (!out.some((kept) => key(kept) === key(item))) out.push(item);
  }
  return out;
}
