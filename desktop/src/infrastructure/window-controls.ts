/**
 * Paints the Windows minimize, maximize and close buttons in the color of the surface beneath them (a CSS variable such
 * as "--stage"), with the theme's text color for the symbols. A no-op outside the Windows desktop app.
 */
export function syncWindowControls(surface: string): void {
  const set = window.saturnDesktop?.setWindowControls;
  if (!set) return;
  const style = getComputedStyle(document.documentElement);
  set({ color: style.getPropertyValue(surface).trim(), symbolColor: style.getPropertyValue("--fg").trim() });
}
