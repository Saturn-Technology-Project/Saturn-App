/** The page numbers for `total` items, `size` per page: [1, 2, …]. */
export function pages(total, size) {
  const count = Math.floor(total / size);
  return Array.from({ length: count }, (_, index) => index + 1);
}
