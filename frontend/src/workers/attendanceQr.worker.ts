import jsQR from 'jsqr';

// Frames stay on the device. No network, storage, analytics or image uploads.
self.onmessage = (event: MessageEvent<{ pixels: ArrayBuffer; width: number; height: number }>) => {
  try {
    const { pixels, width, height } = event.data;
    const code = jsQR(new Uint8ClampedArray(pixels), width, height, { inversionAttempts: 'dontInvert' });
    self.postMessage({ value: code?.data ?? null });
  } catch { self.postMessage({ failed: true }); }
};
