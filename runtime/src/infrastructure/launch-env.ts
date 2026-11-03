/**
 * The environment for programs the runtime starts for the user (Terminal, the browser, git, the
 * Terminal panel's commands): the runtime's own, minus variables that only make sense for this process.
 */
export function launchEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ELECTRON_") || key === "SATURN_DESKTOP_ATTACHED" || key === "SATURN_DESKTOP_PID") continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
