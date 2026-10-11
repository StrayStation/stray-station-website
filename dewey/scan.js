// Live barcode scanning from the phone camera.
// Android Chrome has a built-in BarcodeDetector (fast); iPhone Safari does not, so ZXing decodes frames there.

const scanner = { active: false, stream: null, reader: null, timer: null };

const CAMERA = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
};

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    if (!supported.includes('ean_13')) return null;
    const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((f) => supported.includes(f));
    return new window.BarcodeDetector({ formats });
  } catch {
    return null;
  }
}

/**
 * Start scanning into <video>. onCode(text) is called for each barcode read;
 * return true from it to accept the code (scanning then stops).
 */
export async function startScanner(video, onCode) {
  stopScanner();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot use the camera. Open the app over https in Safari or Chrome.');
  }
  scanner.active = true;
  video.setAttribute('playsinline', '');
  video.muted = true;

  const detector = await nativeDetector();
  if (detector) {
    scanner.stream = await navigator.mediaDevices.getUserMedia(CAMERA);
    if (!scanner.active) return stopScanner();
    video.srcObject = scanner.stream;
    await video.play();
    const tick = async () => {
      if (!scanner.active) return;
      try {
        if (video.readyState >= 2) {
          for (const code of await detector.detect(video)) {
            if (onCode(code.rawValue)) { stopScanner(); return; }
          }
        }
      } catch { /* a dropped frame; keep going */ }
      scanner.timer = setTimeout(tick, 120);
    };
    tick();
    return;
  }

  if (!window.ZXing) throw new Error('The barcode reader did not load. Check your connection and reload.');
  const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = window.ZXing;
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  scanner.reader = new BrowserMultiFormatReader(hints, 250);
  await scanner.reader.decodeFromConstraints(CAMERA, video, (result) => {
    if (result && scanner.active && onCode(result.getText())) stopScanner();
  });
}

export function stopScanner() {
  scanner.active = false;
  clearTimeout(scanner.timer);
  if (scanner.reader) {
    try { scanner.reader.reset(); } catch { /* already stopped */ }
    scanner.reader = null;
  }
  if (scanner.stream) {
    scanner.stream.getTracks().forEach((t) => t.stop());
    scanner.stream = null;
  }
}

export function cameraErrorMessage(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access is blocked. Allow camera access for this site in your browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.';
  return err?.message || 'The camera could not start.';
}
