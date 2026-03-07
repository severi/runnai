import { useState, useEffect, useRef } from "react";

export function useElapsedTimer(isProcessing: boolean): number {
  const processingStartRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isProcessing) {
      setElapsed(0);
      return;
    }
    processingStartRef.current = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - processingStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isProcessing]);

  return elapsed;
}
