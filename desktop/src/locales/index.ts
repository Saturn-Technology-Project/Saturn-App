// Every translation, by language. English needs none: its text is the key.
import type { Dictionary, Locale } from "../domain/i18n";
import research from "./zh-Hant/research";
import settings from "./zh-Hant/settings";
import settingsParts from "./zh-Hant/settings-parts";
import shell from "./zh-Hant/shell";
import workspace from "./zh-Hant/workspace";

/** Each file's dictionary for Traditional Chinese, in the order they are merged. */
export const traditionalChinese: readonly Dictionary[] = [shell, workspace, research, settings, settingsParts];

/** The dictionary for a language. */
export function dictionaryFor(locale: Locale): Dictionary {
  return locale === "zh-Hant" ? Object.assign({}, ...traditionalChinese) : {};
}
