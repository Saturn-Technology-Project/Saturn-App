import { SCREENS, type Screen } from "../../domain/workbench.js";

export { SCREENS, type Screen };

/** Where the app reopens; losing this loses no research. */
export function rememberedScreen(): Screen {
  try {
    const saved = localStorage.getItem("saturn-screen");
    return SCREENS.find((screen) => screen === saved) ?? "Home";
  } catch {
    return "Home";
  }
}

export function rememberScreen(screen: Screen): void {
  try {
    localStorage.setItem("saturn-screen", screen);
  } catch {
    // Only where the app reopens.
  }
}
