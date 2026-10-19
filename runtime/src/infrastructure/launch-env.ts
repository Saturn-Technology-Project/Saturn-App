/**
 * The environment for programs the runtime starts for the user (Saturn IDE, Terminal, the browser, git, the
 * Terminal panel's commands): the runtime's own, minus variables that only make sense for this process. In the
 * packaged app the runtime runs on Electron with ELECTRON_RUN_AS_NODE=1; `open` passes the caller's environment
 * on, and an Electron app such as Saturn IDE that inherits it starts as plain Node and quits at once.
 */
export function launchEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ELECTRON_") || key === "SATURN_DESKTOP_ATTACHED" || key === "SATURN_DESKTOP_PID") continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
