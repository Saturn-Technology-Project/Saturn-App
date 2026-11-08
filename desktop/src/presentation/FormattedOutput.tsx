import katex from "katex";
import "katex/dist/katex.min.css";
import { useState, type ReactNode } from "react";
import { t } from "../domain/i18n.js";
import { parseMarkdown, type Block, type Inline } from "../domain/markdown.js";
import { Button } from "./ui/base/Button.js";

const CODE = "rounded bg-foreground/10 px-[5px] py-px text-[0.92em]";
const HEADING = ["text-base font-semibold", "text-[15px] font-semibold", "text-sm font-semibold", "text-sm font-semibold", "text-[13px] font-semibold", "text-[13px] font-semibold"];

/** A reply as the assistant wrote it: Markdown drawn as headings, lists, tables and quotes, with fenced code as copyable snippets. */
export function FormattedOutput(props: { text: string }) {
  const blocks = parseMarkdown(props.text);
  return <div className="flex flex-col gap-2.5">{blocks.map((block, index) => <Blocks key={index} block={block} />)}</div>;
}

/** One block, drawn. */
function Blocks(props: { block: Block }) {
  const { block } = props;
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(block.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
      return <Tag className={`m-0 mt-1 ${HEADING[block.level - 1] ?? HEADING[5]}`}>{inlines(block.children)}</Tag>;
    }
    case "paragraph":
      return <p className="m-0 whitespace-pre-wrap">{inlines(block.children)}</p>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className={`m-0 flex flex-col gap-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`} start={block.ordered && block.start !== 1 ? block.start : undefined}>
          {block.items.map((item, index) => (
            <li key={index} className="whitespace-pre-wrap">
              {inlines(item.children)}
              {item.nested ? <div className="mt-1"><Blocks block={item.nested} /></div> : null}
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote className="m-0 flex flex-col gap-2 border-l-2 border-border pl-3 text-muted-foreground">
          {block.blocks.map((inner, index) => <Blocks key={index} block={inner} />)}
        </blockquote>
      );
    case "code":
      return <CodeSnippet lang={block.lang} code={block.text} />;
    case "math":
      return <Formula text={block.text} display />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="border-collapse text-[13px]">
            <thead>
              <tr>{block.header.map((cell, index) => <th key={index} className="border-b border-border px-2 py-1 text-left font-semibold">{inlines(cell)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{block.header.map((_, index) => <td key={index} className="border-b border-border/60 px-2 py-1 align-top">{inlines(row[index] ?? [])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr className="my-1 border-border" />;
  }
}

/** The marks inside a block. A link opens in the browser: the shell sends a new window's address there. */
function inlines(items: Inline[]): ReactNode[] {
  return items.map((inline, index) => {
    switch (inline.kind) {
      case "text":
        return inline.text;
      case "code":
        return <code key={index} className={CODE}>{inline.text}</code>;
      case "math":
        return <Formula key={index} text={inline.text} />;
      case "strong":
        return <strong key={index} className="font-semibold">{inlines(inline.children)}</strong>;
      case "em":
        return <em key={index}>{inlines(inline.children)}</em>;
      case "strike":
        return <s key={index}>{inlines(inline.children)}</s>;
      case "link":
        return <a key={index} href={inline.href} target="_blank" rel="noreferrer" title={inline.href} className="text-primary underline underline-offset-2">{inlines(inline.children)}</a>;
    }
  });
}

/**
 * A formula set by KaTeX. Its output is markup KaTeX builds itself from the formula, with nothing from the formula
 * trusted (`trust` stays off, so no links or images); a formula it cannot read is shown as written, in red.
 */
function Formula(props: { text: string; display?: boolean }) {
  const html = katex.renderToString(props.text, { displayMode: props.display ?? false, throwOnError: false, output: "html", strict: "ignore" });
  // eslint-disable-next-line react/no-danger
  return <span className={props.display ? "block overflow-x-auto py-1" : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
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
        <span>{props.lang || t("code")}</span>
        <Button variant="ghost" size="small" className="h-5 px-1.5 text-[11px] text-muted-foreground" onClick={copy}>
          {copied ? t("Copied") : t("Copy")}
        </Button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 text-[12.5px] leading-normal">
        <code>{props.code}</code>
      </pre>
    </div>
  );
}
