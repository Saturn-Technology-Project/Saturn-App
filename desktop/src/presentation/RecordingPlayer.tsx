import { useEffect, useRef, useState } from "react";
import { desktop } from "../application/desktop";
import { Button } from "./ui/base/Button.js";
import { Notice } from "./ui/base/Notice.js";

const FPS = 10;

/**
 * Plays a browser recording an agent made (JPEG frames the runtime serves) at 10 fps, with a scrubber; "Export
 * MP4" asks the runtime to run ffmpeg when it is installed.
 */
export function RecordingPlayer(props: { runId: string; name: string; frames: number; seconds?: number }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const created = useRef<string[]>([]);

  // Frames load in order, so playback can start before the last one is in.
  useEffect(() => {
    let cancelled = false;
    created.current = [];
    setUrls([]);
    setAt(0);
    if (!props.frames) return;
    setLoading(true);
    void (async () => {
      const list: string[] = [];
      for (let index = 1; index <= props.frames; index += 1) {
        if (cancelled) return;
        try {
          const url = URL.createObjectURL(await desktop.runs.recordingFrame(props.runId, props.name, index));
          created.current.push(url);
          list.push(url);
          if (index === 1 || index % 10 === 0 || index === props.frames) setUrls([...list]);
        } catch {
          break;
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
      for (const url of created.current) URL.revokeObjectURL(url);
    };
  }, [props.runId, props.name, props.frames]);

  useEffect(() => {
    if (!playing || !urls.length) return;
    const timer = window.setInterval(() => {
      setAt((current) => {
        if (current + 1 >= urls.length) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1000 / FPS);
    return () => window.clearInterval(timer);
  }, [playing, urls.length]);

  async function exportMp4() {
    setError("");
    try {
      const result = await desktop.runs.exportRecording(props.runId, props.name);
      setExported(result.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not export");
    }
  }

  const frame = urls[Math.min(at, urls.length - 1)];
  return (
    <div className="mt-1.5 mb-2 ml-7 max-w-[640px] overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex min-h-30 items-center justify-center bg-black">
        {frame ? <img className="block h-auto w-full" src={frame} alt={`Recording ${props.name}, frame ${at + 1}`} /> : <span className="text-xs text-muted-foreground">{loading ? "Loading frames…" : "No frames"}</span>}
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5 text-[11.5px]">
        <Button variant="ghost" size="small" disabled={!urls.length} onClick={() => { if (at + 1 >= urls.length) setAt(0); setPlaying((value) => !value); }}>
          {playing ? "Pause" : "Play"}
        </Button>
        <input className="min-w-20 flex-1" type="range" min={0} max={Math.max(0, urls.length - 1)} value={Math.min(at, urls.length - 1)} onChange={(event) => { setPlaying(false); setAt(Number(event.target.value)); }} aria-label="Frame" />
        <span className="text-xs text-muted-foreground">{urls.length ? `${at + 1} / ${props.frames}` : ""}{props.seconds ? ` · ${props.seconds}s` : ""}</span>
        {exported ? <span className="text-xs text-muted-foreground" title={exported}>MP4 saved</span> : <Button variant="ghost" size="small" onClick={() => void exportMp4()}>Export MP4</Button>}
      </div>
      {error ? <Notice tone="bad" className="m-2">{error}</Notice> : null}
    </div>
  );
}
