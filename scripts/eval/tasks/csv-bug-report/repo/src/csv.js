/** Parses CSV text into rows of fields. */
export function parse(text) {
  return text.split('\n').filter((line) => line.length).map((line) => line.split(','));
}
