// The interface's words in the person's language. Text is written in English where it is used, and
// the English is the key: a missing translation shows the English rather than nothing.

/** A language the interface is written in. */
export type Locale = "en" | "zh-Hant";

/** What the person chose in Settings: a language, or whatever the system uses. */
export type LanguageChoice = "auto" | Locale;

/** English text to the same text in another language, with the same `{name}` placeholders. */
export type Dictionary = Readonly<Record<string, string>>;

/** Values put into a text's `{name}` placeholders. */
export type TextParams = Readonly<Record<string, string | number>>;

let current: Dictionary = {};

/** The language a choice comes to, given the system's languages in order of preference. */
export function resolveLocale(choice: LanguageChoice, languages: readonly string[]): Locale {
  if (choice !== "auto") return choice;
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (!tag.startsWith("zh")) {
      if (tag.startsWith("en")) return "en";
      continue;
    }
    // Simplified Chinese readers get English rather than a script they did not ask for.
    if (tag.includes("hans") || tag === "zh-cn" || tag === "zh-sg") return "en";
    return "zh-Hant";
  }
  return "en";
}

/** The `{name}` placeholders in a text, sorted, each once. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
}

/** A text from a dictionary, with its placeholders filled. */
export function translate(dictionary: Dictionary, text: string, params?: TextParams): string {
  const found = Object.hasOwn(dictionary, text) ? dictionary[text] : text;
  if (!params) return found;
  return found.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

/** Sets the dictionary `t` reads; the interface does it once, before anything is shown. */
export function setDictionary(dictionary: Dictionary) {
  current = dictionary;
}

/** English text in the interface's language. The text must be a string literal, so the check in `test/i18n.test.mjs` finds it. */
export function t(text: string, params?: TextParams): string {
  return translate(current, text, params);
}
