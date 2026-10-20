import { useEffect, useRef, useState } from "react";
import { desktop } from "../application/desktop";
import type { ContextItem } from "../domain/model";

type Kind = "files" | "folder" | "git" | "terminal" | "problems" | "web";

const KINDS: { id: Kind; label: string; detail: string }[] = [
  { id: "files", label: "Files", detail: "One or more files from the project" },
  { id: "folder", label: "Folder listing", detail: "The files in a folder, by name" },
  { id: "git", label: "Git changes", detail: "The uncommitted diff" },
  { id: "problems", label: "Problems", detail: "What the project's check command reports now" },
  { id: "terminal", label: "Terminal", detail: "The last commands agents ran here, with their output" },
  { id: "web", label: "Web page", detail: "The text of a public URL" },
];

/**
 * The "@" menu of the composer: what to attach to the next message. Files are searched in the project through the
 * runtime; everything else is one click. Closes on Escape or a click outside.
 */
export function ContextPicker(props: { projectId: string; onPick: (items: ContextItem[]) => void; onClose: () => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    const onClick = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) props.onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [props.onClose]);

  useEffect(() => {
    if (kind !== "files" && kind !== "folder") return;
    let stale = false;
    desktop.projects.files(props.projectId, query).then((list) => {
      if (stale) return;
      // Folders come from the files' parent directories.
      setFiles(kind === "folder" ? [...new Set(list.map((item) => item.split("/").slice(0, -1).join("/")).filter(Boolean))].sort() : list);
    }, (reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not list files"));
    window.setTimeout(() => input.current?.focus(), 20);
    return () => {
      stale = true;
    };
  }, [kind, query, props.projectId]);

  function pick(items: ContextItem[]) {
    props.onPick(items);
    props.onClose();
  }

  function choose(id: Kind) {
    if (id === "git") return pick([{ kind: "git", label: "git changes" }]);
    if (id === "terminal") return pick([{ kind: "terminal", label: "terminal" }]);
    if (id === "problems") return pick([{ kind: "problems", label: "problems" }]);
    setKind(id);
    setQuery("");
    setChosen(new Set());
  }

  return (
    <div className="context-picker" ref={box} role="dialog" aria-label="Attach context">
      {kind === null ? (
        <ul className="context-picker-list">
          {KINDS.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => choose(item.id)}>
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : kind === "web" ? (
        <form
          className="context-picker-form"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = url.trim();
            if (!/^https?:\/\/\S+$/.test(trimmed)) {
              setError("Enter an http(s) URL");
              return;
            }
            pick([{ kind: "web", url: trimmed, label: trimmed.replace(/^https?:\/\//, "").slice(0, 40) }]);
          }}
        >
          <input ref={input} className="input" placeholder="https://…" value={url} autoFocus onChange={(event) => setUrl(event.target.value)} />
          <button type="submit" className="btn tiny">Attach</button>
        </form>
      ) : (
        <div className="context-picker-files">
          <input
            ref={input}
            className="input"
            placeholder={kind === "files" ? "Search files…" : "Search folders…"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && kind === "files" && files[0] && chosen.size === 0) {
                event.preventDefault();
                pick([{ kind: "file", path: files[0], label: files[0].split("/").pop() || files[0] }]);
              }
            }}
          />
          <ul>
            {files.slice(0, 60).map((file) => (
              <li key={file}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(file)}
                    onChange={(event) => {
                      const next = new Set(chosen);
                      if (event.target.checked) next.add(file);
                      else next.delete(file);
                      setChosen(next);
                    }}
                  />
                  <span>{file}</span>
                </label>
              </li>
            ))}
            {files.length === 0 ? <li className="hint">No matches</li> : null}
          </ul>
          <div className="context-picker-actions">
            <button type="button" className="btn ghost tiny" onClick={() => setKind(null)}>Back</button>
            <button
              type="button"
              className="btn tiny"
              disabled={chosen.size === 0}
              onClick={() => pick([...chosen].map((path) => (kind === "files"
                ? { kind: "file", path, label: path.split("/").pop() || path }
                : { kind: "folder", path, label: `${path.split("/").pop() || path}/` })))}
            >
              Attach {chosen.size || ""}
            </button>
          </div>
        </div>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
