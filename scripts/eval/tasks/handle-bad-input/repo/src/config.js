export const DEFAULTS = { port: 3000, verbose: false };

export function parseConfig(text) {
  return { ...DEFAULTS, ...JSON.parse(text) };
}
