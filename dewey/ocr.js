// Image helpers and on-device text reading (Tesseract.js, free, loaded only when first needed).

const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let tesseractLoading = null;

function ensureTesseract() {
  if (window.Tesseract) return Promise.resolve();
  tesseractLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_SRC;
    s.onload = () => resolve();
    s.onerror = () => {
      tesseractLoading = null;
      reject(new Error('The text reader could not load. Check your connection and try again.'));
    };
    document.head.append(s);
  });
  return tesseractLoading;
}

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be opened. Try a JPEG or PNG.')); };
    img.src = url;
  });
}

/** Draw a photo onto a canvas no larger than maxSide, optionally as high-contrast grayscale for OCR. */
export async function fileToCanvas(file, maxSide, forOcr = false) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: forOcr });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  if (forOcr) {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    let min = 255, max = 0;
    for (let i = 0; i < px.length; i += 4) {
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      px[i] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0; i < px.length; i += 4) {
      const v = ((px[i] - min) / range) * 255;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);
  }
  return canvas;
}

/** Shrink a cover photo to a reasonable JPEG before upload (keeps storage well inside the free tier). */
export async function fileToJpeg(file, maxSide = 1000, quality = 0.82) {
  const canvas = await fileToCanvas(file, maxSide, false);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('That photo could not be processed.'))), 'image/jpeg', quality),
  );
}

/** Read text from a photo. onProgress receives 0–1 while recognizing. */
export async function readText(file, onProgress) {
  await ensureTesseract();
  const canvas = await fileToCanvas(file, 2000, true);
  const result = await window.Tesseract.recognize(canvas, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) onProgress(m.progress);
    },
  });
  return result.data?.text || '';
}
