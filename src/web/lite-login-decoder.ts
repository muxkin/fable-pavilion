type ImageSource = HTMLVideoElement | HTMLImageElement | ImageBitmap;
type Detector = { detect(source: ImageSource): Promise<{ rawValue: string }[]> };
type DetectorConstructor = {
  new (settings: { formats: ['qr_code'] }): Detector;
  getSupportedFormats?(): Promise<string[]>;
};

/** Use the browser decoder when available. Software decoding is downloaded on demand. */
export async function qrDecoder(trySoftwareWhenNotFound = false) {
  const BarcodeDetector = (window as Window & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
  if (BarcodeDetector) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats?.();
      if (!formats || formats.includes('qr_code')) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        let fallback: ReturnType<typeof softwareDecoder> | undefined;
        return async (source: ImageSource) => {
          if (!fallback) {
            try {
              const text = (await detector.detect(source))[0]?.rawValue;
              if (text || !trySoftwareWhenNotFound) return text;
            } catch {
              // The native decoder can also fail on individual images.
            }
            fallback = softwareDecoder();
          }
          return (await fallback)(source);
        };
      }
    } catch {
      // The constructor can exist even when the native service is unavailable.
    }
  }
  return softwareDecoder();
}

export async function decodeQrImage(file: File, isCurrent = () => true) {
  if (file.size > 10 * 1024 * 1024) throw new Error('二维码图片不能超过 10 MB');
  // Some mobile browsers can render an image but lack a working ImageBitmap decoder.
  let bitmap: ImageBitmap | undefined;
  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      // Retry with the browser's image element decoder.
    }
  }
  if (bitmap) {
    try {
      return isCurrent() ? await (await qrDecoder(true))(bitmap) : undefined;
    } finally {
      bitmap.close();
    }
  }
  if (!isCurrent()) return;
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('无法读取二维码图片，请换一张图片重试。'));
      image.src = url;
    });
    return isCurrent() ? await (await qrDecoder(true))(image) : undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function softwareDecoder() {
  const { default: decode } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法识别二维码，请粘贴登录邀请链接。');
  return async (source: ImageSource) => {
    const video = source instanceof HTMLVideoElement;
    const image = source instanceof HTMLImageElement;
    const width = video ? source.videoWidth : image ? source.naturalWidth : source.width;
    const height = video ? source.videoHeight : image ? source.naturalHeight : source.height;
    if (!width || !height) return;
    const scale = Math.min(1, (video ? 960 : 2048) / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return decode(pixels.data, pixels.width, pixels.height)?.data;
  };
}
