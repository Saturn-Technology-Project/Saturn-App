import { RuntimeClient } from "../infrastructure/runtime-client.js";

export interface TerminalInfo {
  cwd: string;
  shell: string;
  user: string;
  hostname: string;
}

export interface TerminalExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export interface WorkspaceFilesResponse {
  kind: "directory" | "file";
  path: string;
  entries?: WorkspaceFileEntry[];
  content?: string;
}

export class WorkspaceService {
  constructor(private readonly runtime: RuntimeClient) {}

  info(): Promise<TerminalInfo> {
    return this.runtime.request<TerminalInfo>("/workspace/info");
  }

  exec(command: string, cwd?: string): Promise<TerminalExecResult> {
    return this.runtime.request<TerminalExecResult>("/workspace/terminal", {
      method: "POST",
      body: JSON.stringify({ command, cwd }),
    });
  }

  openNativeTerminal(cwd?: string): Promise<{ opened: boolean; cwd: string }> {
    return this.runtime.request<{ opened: boolean; cwd: string }>("/workspace/terminal/open", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
  }

  openNativeEditor(cwd?: string): Promise<{ opened: boolean; cwd?: string; editor?: string }> {
    return this.runtime.request<{ opened: boolean; cwd?: string; editor?: string }>("/workspace/editor/open", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
  }

  openNativeBrowser(url: string): Promise<{ opened: boolean; url: string }> {
    return this.runtime.request<{ opened: boolean; url: string }>("/workspace/browser/open", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  files(relPath = ""): Promise<WorkspaceFilesResponse> {
    return this.runtime.request<WorkspaceFilesResponse>(
      `/workspace/files?path=${encodeURIComponent(relPath)}`,
    );
  }

  /** A public page through the runtime's proxy, as HTML for a sandboxed srcdoc frame, with the address it ended at. */
  async loadPage(url: string): Promise<{ html: string; url: string }> {
    const { text, headers } = await this.runtime.text(`/workspace/browser/proxy?url=${encodeURIComponent(url)}`);
    return { html: text, url: headers.get("x-saturn-url") ?? url };
  }
}
