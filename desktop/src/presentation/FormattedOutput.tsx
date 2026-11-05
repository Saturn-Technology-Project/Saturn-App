import { useState } from "react";
import { Button } from "./ui/base/Button.js";

/** A reply with fenced code blocks shown as copyable snippets. */
export function FormattedOutput(props: { text: string }) {
  const blocks = splitCodeBlocks(props.text);
  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <CodeSnippet key={index} lang={block.lang} code={block.content} />
        ) : (
          <p className="whitespace-pre-wrap" key={index}>
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
    <div className="overflow-hidden rounded-lg border border-border bg-(--code-bg)">
      <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <span>{props.lang || "code"}</span>
        <Button variant="ghost" size="small" className="h-5 px-1.5 text-[11px] text-muted-foreground" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 text-[12.5px] leading-normal">
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
