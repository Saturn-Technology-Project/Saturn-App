/** The visible rectangle of the part of the interface a tour step describes. */
export interface TourBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** How long a window out of sight waits between measurements: the system stops animation frames for it. */
const OUT_OF_SIGHT_MS = 250;

/**
 * Follows layout while a step is open, measuring at once and then on every frame, or on a timer in a window that is behind
 * others or driven from the background, which gets no frames. Stopping also invalidates anything already queued.
 */
export function followTourTarget(
  read: () => TourBox | null,
  report: (box: TourBox | null) => void,
  scheduleFrame: (callback: () => void) => number,
  cancelFrame: (frame: number) => void,
  scheduleTimer: (callback: () => void, milliseconds: number) => number = (callback, milliseconds) => setTimeout(callback, milliseconds) as unknown as number,
  cancelTimer: (timer: number) => void = (timer) => clearTimeout(timer),
): () => void {
  let live = true;
  let previous: TourBox | null | undefined;
  let frame = 0;
  let timer = 0;
  function measure() {
    if (!live) return;
    cancelFrame(frame);
    cancelTimer(timer);
    const box = read();
    if (previous === undefined || box?.top !== previous?.top || box?.left !== previous?.left || box?.width !== previous?.width || box?.height !== previous?.height) {
      previous = box;
      report(box);
    }
    frame = scheduleFrame(measure);
    timer = scheduleTimer(measure, OUT_OF_SIGHT_MS);
  }
  measure();
  return () => {
    live = false;
    cancelFrame(frame);
    cancelTimer(timer);
  };
}
