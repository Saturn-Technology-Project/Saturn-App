import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";

/** The images a message was sent with, loaded through the runtime (its requests carry the session token). */
export function RunImages(props: { runId: string; count: number }) {
  const [urls, setUrls] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    void Promise.all(
      Array.from({ length: props.count }, (_, index) =>
        desktop.runs.image(props.runId, index).then((blob) => {
          const url = URL.createObjectURL(blob);
          created.push(url);
          return url;
        }, () => ""),
      ),
    ).then((list) => {
      if (!cancelled) setUrls(list.filter(Boolean));
    });
    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [props.runId, props.count]);

  if (!urls.length) return null;
  return (
    <div className="user-images">
      {urls.map((url, index) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" title="Open the image">
          <img src={url} alt={`Attached image ${index + 1}`} />
        </a>
      ))}
    </div>
  );
}
