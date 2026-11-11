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
// Until told otherwise shortcuts stay as written, the Mac's way.
let macShortcuts = true;

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

/** A text from a dictionary, its shortcuts as a Mac or another system writes them, with its placeholders filled. */
export function translate(dictionary: Dictionary, text: string, params?: TextParams, mac = true): string {
  const found = shortcutsOn(mac, Object.hasOwn(dictionary, text) ? dictionary[text] : text);
  if (!params) return found;
  return found.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

/** Sets the dictionary `t` reads; the interface does it once, before anything is shown. */
export function setDictionary(dictionary: Dictionary) {
  current = dictionary;
}

/**
 * A text's keyboard shortcuts as this system writes them. Shortcuts are written the Mac's way in the source ("⌘K",
 * "⌘ 1 to 7", "⌘↵"); anywhere else the same keys are pressed with Ctrl and read "Ctrl+K", "Ctrl+1 to 7", "Ctrl+Enter".
 */
export function shortcutsOn(mac: boolean, text: string): string {
  if (mac) return text;
  return text.replace(/⌘ ?([A-Za-z0-9,↵])/g, (_whole, key: string) => `Ctrl+${key === "↵" ? "Enter" : key}`);
}

/** Says whether this is a Mac, for `t` and `shortcut`; the interface does it once, before anything is shown. */
export function setMacShortcuts(mac: boolean) {
  macShortcuts = mac;
}

/** A shortcut that is not part of a sentence ("⌘K"), as this system writes it. */
export function shortcut(keys: string): string {
  return shortcutsOn(macShortcuts, keys);
}

/**
 * English text in the interface's language, with any shortcut in it as this system writes it. The text must be a string
 * literal, so the check in `test/i18n.test.mjs` finds it.
 */
export function t(text: string, params?: TextParams): string {
  return translate(current, text, params, macShortcuts);
}
