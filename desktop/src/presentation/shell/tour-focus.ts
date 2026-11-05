/** The visible rectangle of the part of the interface a tour step describes. */
export interface TourBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Follows layout while a step is open; stopping also invalidates a frame that was already queued. */
export function followTourTarget(
  read: () => TourBox | null,
  report: (box: TourBox | null) => void,
  schedule: (callback: () => void) => number,
  cancel: (frame: number) => void,
): () => void {
  let live = true;
  let previous: TourBox | null | undefined;
  let frame: number;
  function measure() {
    if (!live) return;
    const box = read();
    if (previous === undefined || box?.top !== previous?.top || box?.left !== previous?.left || box?.width !== previous?.width || box?.height !== previous?.height) {
      previous = box;
      report(box);
    }
    frame = schedule(measure);
  }
  frame = schedule(measure);
  return () => {
    live = false;
    cancel(frame);
  };
}
