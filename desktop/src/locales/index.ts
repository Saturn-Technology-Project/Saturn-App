// Every translation, by language. The text in the code is the key; English shows it unless the English dictionary
// words it better, so copy can change here without touching the code.
import type { Dictionary, Locale } from "../domain/i18n";
import englishResearch from "./en/research";
import englishSettings from "./en/settings";
import englishSettingsParts from "./en/settings-parts";
import englishShell from "./en/shell";
import englishWorkspace from "./en/workspace";
import research from "./zh-Hant/research";
import settings from "./zh-Hant/settings";
import settingsParts from "./zh-Hant/settings-parts";
import shell from "./zh-Hant/shell";
import workspace from "./zh-Hant/workspace";

/** Each file's dictionary for Traditional Chinese, in the order they are merged. */
export const traditionalChinese: readonly Dictionary[] = [shell, workspace, research, settings, settingsParts];

/** Each file's English wording, where it differs from the code's text. */
export const english: readonly Dictionary[] = [englishShell, englishWorkspace, englishResearch, englishSettings, englishSettingsParts];

/** The dictionary for a language. */
export function dictionaryFor(locale: Locale): Dictionary {
  return Object.assign({}, ...(locale === "zh-Hant" ? traditionalChinese : english));
}
