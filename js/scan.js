// Barcode scanning. Chrome on Android has a built-in detector; Safari doesn't, so we load
// a free WebAssembly version (ZXing) the first time it's needed. The service worker caches it.
const POLYFILL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.3/+esm';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

async function getDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (FORMATS.some(f => supported.includes(f))) return new window.BarcodeDetector({ formats: FORMATS });
    } catch (e) { /* fall through to polyfill */ }
  }
  const mod = await import(POLYFILL);
  return new mod.BarcodeDetector({ formats: FORMATS });
}

// Starts the camera in `video`, resolves with the first barcode found. Call stop() to cancel.
export function startScan(video) {
  let stream, raf, stopped = false;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  };
  const result = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the camera.');
    const [detector, s] = await Promise.all([
      getDetector(),
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false }),
    ]);
    stream = s;
    if (stopped) { stop(); return null; }
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    await video.play();
    return await new Promise((resolve, reject) => {
      let busy = false, last = 0;
      const tick = async t => {
        if (stopped) return resolve(null);
        raf = requestAnimationFrame(tick);
        if (busy || t - last < 120 || video.readyState < 2) return;
        busy = true; last = t;
        try {
          const codes = await detector.detect(video);
          if (codes.length && !stopped) { stop(); resolve(codes[0].rawValue); }
        } catch (e) { stop(); reject(e); }
        busy = false;
      };
      raf = requestAnimationFrame(tick);
    });
  })();
  return { result, stop };
}
