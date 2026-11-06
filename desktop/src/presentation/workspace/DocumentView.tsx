import { useEffect, useMemo } from "react";
import { PdfView } from "./PdfView.js";

/** A paper or a figure from the project, shown as it is: a PDF drawn by pdf.js, or the image. Nothing is edited. */
export function DocumentView(props: { path: string; mime: string; data: string }) {
  const bytes = useMemo(() => Uint8Array.from(atob(props.data), (character) => character.charCodeAt(0)), [props.data]);
  // An image becomes a local blob address the page alone can read; it is let go when another file opens.
  const address = useMemo(() => (props.mime === "application/pdf" ? null : URL.createObjectURL(new Blob([bytes], { type: props.mime }))), [bytes, props.mime]);
  useEffect(() => () => {
    if (address) URL.revokeObjectURL(address);
  }, [address]);

  if (!address) return <PdfView path={props.path} bytes={bytes} />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-4">
      <img className="max-h-full max-w-full object-contain" src={address} alt={props.path} />
    </div>
  );
}
