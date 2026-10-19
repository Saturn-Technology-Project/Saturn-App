import { useState } from "react";

/** A reply with fenced code blocks shown as copyable snippets. */
export function FormattedOutput(props: { text: string }) {
  const blocks = splitCodeBlocks(props.text);
  return (
    <div className="formatted-output">
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <CodeSnippet key={index} lang={block.lang} code={block.content} />
        ) : (
          <p className="assistant-paragraph" key={index}>
            {block.content}
          </p>
        ),
      )}
    </div>
  );
}

function CodeSnippet(props: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard?.writeText(props.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{props.lang || "code"}</span>
        <button type="button" className="copy-btn" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

function splitCodeBlocks(text: string): { kind: "text" | "code"; lang: string; content: string }[] {
  const result: { kind: "text" | "code"; lang: string; content: string }[] = [];
  const pattern = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const slice = text.slice(lastIndex, match.index).trim();
      if (slice) result.push({ kind: "text", lang: "", content: slice });
    }
    result.push({
      kind: "code",
      lang: match[1] ?? "",
      content: (match[2] ?? "").replace(/\n$/, ""),
    });
    lastIndex = pattern.lastIndex;
  }
  const rest = text.slice(lastIndex).trim();
  if (rest || result.length === 0) {
    result.push({ kind: "text", lang: "", content: rest || text });
  }
  return result;
}
