import { useEffect, useRef, useState } from "react";
import { desktop } from "../application/desktop";

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
    <div className="recording">
      <div className="recording-screen">
        {frame ? <img src={frame} alt={`Recording ${props.name}, frame ${at + 1}`} /> : <span className="hint">{loading ? "Loading frames…" : "No frames"}</span>}
      </div>
      <div className="recording-bar">
        <button type="button" className="btn ghost tiny" disabled={!urls.length} onClick={() => { if (at + 1 >= urls.length) setAt(0); setPlaying((value) => !value); }}>
          {playing ? "Pause" : "Play"}
        </button>
        <input type="range" min={0} max={Math.max(0, urls.length - 1)} value={Math.min(at, urls.length - 1)} onChange={(event) => { setPlaying(false); setAt(Number(event.target.value)); }} aria-label="Frame" />
        <span className="hint">{urls.length ? `${at + 1} / ${props.frames}` : ""}{props.seconds ? ` · ${props.seconds}s` : ""}</span>
        {exported ? <span className="hint" title={exported}>MP4 saved</span> : <button type="button" className="btn ghost tiny" onClick={() => void exportMp4()}>Export MP4</button>}
      </div>
      {error ? <span className="error">{error}</span> : null}
    </div>
  );
}
