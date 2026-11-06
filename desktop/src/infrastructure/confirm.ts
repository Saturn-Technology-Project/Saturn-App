/**
 * Asks the user to confirm something: the system's own dialog in the desktop app, whose web view has no `window.confirm`
 * (on macOS it answers false without showing anything), the browser's in a plain browser.
 */
export async function askToConfirm(message: string): Promise<boolean> {
  const confirm = (globalThis as { saturnDesktop?: { confirm?: (text: string) => Promise<boolean> } }).saturnDesktop?.confirm;
  return confirm ? await confirm(message) : window.confirm(message);
}
