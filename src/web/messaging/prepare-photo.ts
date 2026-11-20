/** Fit a large gallery photo within the server limit. Sending it as a file keeps its original bytes. */
export async function preparePhoto(file: File, limit: number, signal: AbortSignal): Promise<File> {
  if (file.size <= limit) return file;
  signal.throwIfAborted();
  const image = await createImageBitmap(file).catch(() => {
    signal.throwIfAborted();
    throw new Error('照片超过 10 MB，且当前浏览器无法读取它。请改选较小的 JPEG 或 PNG。');
  });
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    const ratio = Math.min(1, 2560 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法缩小这张照片，请改选 10 MB 以内的照片。');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    signal.throwIfAborted();
    if (!blob?.size || blob.size > limit)
      throw new Error('缩小后的照片仍无法上传，请改选 10 MB 以内的照片。');
    const name = file.name.replace(/\.[^.]+$/, '') || '照片';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    image.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
