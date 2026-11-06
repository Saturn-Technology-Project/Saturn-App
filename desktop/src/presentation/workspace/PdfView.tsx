import { useEffect, useRef, useState } from "react";
import { t } from "../../domain/i18n.js";
import { Button } from "../ui/base/Button.js";

/** Steps the zoom moves through, as a share of the pane's width. */
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * A PDF drawn page by page onto canvases by pdf.js, in its own worker. No frame and no plugin: the interface's policy
 * stays as strict as it is, and nothing in the file runs.
 */
export function PdfView(props: { path: string; bytes: Uint8Array }) {
  const pages = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(2);
  const [count, setCount] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const holder = pages.current;
    if (!holder) return undefined;
    holder.replaceChildren();
    setProblem(null);
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        // A copy, since the worker takes the buffer it is given.
        const loading = pdfjs.getDocument({ data: props.bytes.slice(), enableXfa: false });
        const document = await loading.promise;
        if (!live) return;
        setCount(document.numPages);
        // The pane less its padding and a scroll bar, so a page at 100% never scrolls sideways.
        const width = holder.clientWidth - 52;
        for (let number = 1; number <= document.numPages && live; number += 1) {
          const page = await document.getPage(number);
          const natural = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / natural.width) * ZOOMS[zoom] });
          const ratio = window.devicePixelRatio || 1;
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.className = "mx-auto mb-4 block bg-white shadow-sm";
          canvas.setAttribute("aria-label", t("Page {page} of {count}", { page: number, count: document.numPages }));
          holder.append(canvas);
          await page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
        }
        await loading.destroy();
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [props.bytes, zoom]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-1.5 border-b border-border px-2.5 py-1 text-xs text-muted-foreground">
        <span>{count === null ? t("Loading…") : count === 1 ? t("1 page") : t("{count} pages", { count })}</span>
        <span className="ml-auto" />
        <Button variant="ghost" size="small" aria-label={t("Zoom out")} disabled={zoom === 0} onClick={() => setZoom((current) => Math.max(0, current - 1))}>
          −
        </Button>
        <span className="w-10 text-center">{Math.round(ZOOMS[zoom] * 100)}%</span>
        <Button variant="ghost" size="small" aria-label={t("Zoom in")} disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((current) => Math.min(ZOOMS.length - 1, current + 1))}>
          +
        </Button>
      </div>
      {problem ? <div className="p-4 text-sm text-wait">{t("This PDF could not be shown: {reason}", { reason: problem })}</div> : null}
      <div ref={pages} className="min-h-0 flex-1 overflow-auto bg-muted/40 px-4 py-4" role="document" aria-label={props.path} />
    </div>
  );
}
