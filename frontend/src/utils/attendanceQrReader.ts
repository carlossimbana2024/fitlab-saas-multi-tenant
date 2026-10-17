/** One frame in flight. The worker and jsQR are loaded only on camera activation. */
export function createAttendanceQrReader() {
  let disposed = false;
  let worker: Worker | null = null;
  let pending: { resolve: (value: string | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let fallback: Promise<typeof import('jsqr')> | null = null;

  const releaseWorker = () => {
    worker?.terminate(); worker = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(null); pending = null; }
  };
  try {
    if (typeof Worker !== 'undefined') {
      worker = new Worker(new URL('../workers/attendanceQr.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ value?: string | null; failed?: boolean }>) => {
        if (event.data.failed) { releaseWorker(); return; }
        if (pending) { const request = pending; pending = null; clearTimeout(request.timer); request.resolve(typeof event.data.value === 'string' ? event.data.value : null); }
      };
      worker.onerror = event => { event.preventDefault(); releaseWorker(); };
      worker.onmessageerror = releaseWorker;
    }
  } catch { releaseWorker(); }

  return {
    async decode(frame: ImageData): Promise<string | null> {
      if (disposed) return null;
      if (worker) return new Promise(resolve => {
        // The caller waits for this result before scheduling another frame.
        const timer = setTimeout(releaseWorker, 10_000);
        pending = { resolve, timer };
        try { worker!.postMessage({ pixels: frame.data.buffer, width: frame.width, height: frame.height }, [frame.data.buffer as ArrayBuffer]); }
        catch { releaseWorker(); }
      });
      // Safari/embedded browsers with unavailable or blocked module workers.
      fallback ??= import('jsqr');
      const { default: jsQR } = await fallback;
      if (disposed) return null;
      return jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
    },
    dispose() { disposed = true; releaseWorker(); },
  };
}
