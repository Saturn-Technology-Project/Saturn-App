/** Counts lines, words and characters of the text. */
export function count(text) {
  return { lines: text === '' ? 0 : text.split('\n').length, words: text.split(/\s+/).filter(Boolean).length, chars: text.length };
}

/** The CLI's output for argv (without node and the script) and the input text. */
export function run(argv, text) {
  const counts = count(text);
  return `lines ${counts.lines}\nwords ${counts.words}\nchars ${counts.chars}`;
}
