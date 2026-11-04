import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { messageOf } from "./Parts.js";

/** Loads something when a screen opens and whenever research records change; what the runtime says is the truth. */
export function useRecords<T>(load: () => Promise<T>, notify: (message: string) => void) {
  const [value, setValue] = useState<T | null>(null);
  const latest = useRef(load);
  latest.current = load;
  const refresh = useCallback(async () => {
    try {
      setValue(await latest.current());
    } catch (error) {
      notify(messageOf(error));
    }
  }, [notify]);
  useEffect(() => {
    void refresh();
    return desktop.live.onResearchChange(() => void refresh());
  }, [refresh]);
  return { value, refresh };
}
