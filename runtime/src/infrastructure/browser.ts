import { spawn } from "node:child_process";
import { errorText, logger } from "./logger.js";

/** Opens a URL in the user's default browser (used for provider sign-in pages). */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => logger.warn("mcp", `Could not open the browser for sign-in: ${errorText(error)}`));
  child.unref();
}
