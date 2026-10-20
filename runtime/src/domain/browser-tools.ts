import type { McpConnection, ToolRoute } from "./model.js";

export const BROWSER_ID = "browser";
export const BROWSER_URL = "builtin://browser";

const tool = (toolId: string, category: "read" | "write", description: string, properties: Record<string, unknown>, required: string[] = []): ToolRoute => ({
  toolId,
  serverId: BROWSER_ID,
  category,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  environments: ["production"],
});

const ELEMENT = {
  id: { type: "integer", description: "An element id in brackets from the latest snapshot (preferred)." },
  selector: { type: "string", description: "A CSS selector, when no snapshot id fits." },
};

/**
 * A browser driven through the Chrome DevTools Protocol. Pages are read as an accessibility tree (text with
 * element ids), not as pixels, so actions name the element they mean and the result says what changed.
 */
export const BROWSER_TOOLS: ToolRoute[] = [
  tool("browser_navigate", "read", "Open a public web page in the agent's browser and read it as an accessibility snapshot: one element per line, \"[id] role name=… value=…\". Use the ids with browser_click and browser_type. Local and private addresses are refused.", {
    url: { type: "string", description: "The page to open (https:// is assumed)." },
  }, ["url"]),
  tool("browser_snapshot", "read", "Read the current page again as an accessibility snapshot (after the page changed, or to get fresh element ids). Every action also returns a snapshot, so call this only when you need one on its own.", {}),
  tool("browser_click", "write", "Click an element by its snapshot id or a CSS selector. Returns the page after the click.", ELEMENT),
  tool("browser_type", "write", "Type text into a field (by snapshot id or selector; the focused element when neither is given). Clears the field first unless clear is false. submit: true presses Enter afterwards.", {
    ...ELEMENT,
    text: { type: "string", description: "The text to type." },
    clear: { type: "boolean", description: "Clear the field first. Defaults to true." },
    submit: { type: "boolean", description: "Press Enter after typing." },
  }, ["text"]),
  tool("browser_press", "write", "Press a key or chord in the page: Enter, Tab, Escape, ArrowDown, PageDown, or a chord like \"cmd+a\" / \"ctrl+f\".", {
    key: { type: "string", description: "The key or chord." },
  }, ["key"]),
  tool("browser_scroll", "write", "Scroll the page.", {
    direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Defaults to down." },
    pixels: { type: "integer", description: "How far, in pixels (100–5000). Defaults to 600." },
  }),
  tool("browser_screenshot", "read", "A screenshot of the page: returned as an image, or saved under the workspace when file is given (e.g. \"shots/home.jpg\"). Use snapshots to read pages; screenshots are for showing the user or for a recording.", {
    file: { type: "string", description: "Save to this path (relative to the workspace) instead of returning the image." },
    fullPage: { type: "boolean", description: "Capture the whole page, not only the viewport." },
  }),
  tool("browser_evaluate", "write", "Run a JavaScript expression in the page and return its value (JSON). For reading data a snapshot does not show, or small page tweaks.", {
    expression: { type: "string", description: "The expression; may use await." },
  }, ["expression"]),
  tool("browser_record_start", "write", "Start recording the page (a screencast) into workspace/recordings/<name>/ as JPEG frames, for a demo video. Stop with browser_record_stop, which also writes frames.txt for ffmpeg.", {
    name: { type: "string", description: "Folder name for the recording." },
  }),
  tool("browser_record_stop", "write", "Stop the recording and report the folder and frame count.", {}),
  tool("browser_close", "write", "Close the agent's browser. It also closes on its own after five idle minutes.", {}),
];

export function browserSkills(): McpConnection {
  return { id: BROWSER_ID, name: "Browser", url: BROWSER_URL, tools: BROWSER_TOOLS };
}
