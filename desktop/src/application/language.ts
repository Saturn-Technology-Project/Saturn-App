// The language the interface shows, chosen in Settings and kept on this computer. It is set before any
// screen is imported, so text worked out when a module loads is already in that language.
import { type LanguageChoice, type Locale, resolveLocale, setDictionary, setMacShortcuts } from "../domain/i18n";
import { dictionaryFor } from "../locales";

const KEY = "saturn-language";

/** What the person chose, or "auto" when nothing is stored. */
export function languageChoice(): LanguageChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "zh-Hant" || saved === "auto") return saved;
  } catch {
    // Storage can be unavailable; the system's language is used.
  }
  return "auto";
}

/** Keeps a new choice and reloads, so every screen is shown in it. */
export function chooseLanguage(choice: LanguageChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    return;
  }
  window.location.reload();
}

/** The language in use since the interface loaded. */
export const locale: Locale = resolveLocale(languageChoice(), navigator.languages ?? [navigator.language]);

setDictionary(dictionaryFor(locale));
// Shortcuts are written the Mac's way; on Windows the same keys are pressed with Ctrl, and say so.
setMacShortcuts(/Mac/i.test(navigator.platform));
document.documentElement.lang = locale === "zh-Hant" ? "zh-Hant" : "en";
