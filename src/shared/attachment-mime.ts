const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const starts = (data: Uint8Array, value: number[]) => value.every((b, i) => data[i] === b);
function isUtf8(data: Uint8Array) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** MIME is derived from bytes, never from an untrusted upload Content-Type. */
export function attachmentMime(name: string, data: Uint8Array): string {
  if (starts(data, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(decode(data.subarray(0, 6)))) return 'image/gif';
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  if (
    data.length >= 12 &&
    decode(data.subarray(4, 8)) === 'ftyp' &&
    /^(?:avif|avis|mif1|msf1)$/.test(decode(data.subarray(8, 12)))
  )
    return 'image/avif';
  if (/\.svg$/i.test(name) && !data.includes(0) && isUtf8(data)) {
    const head = decode(data.subarray(0, 1024)).replace(/^\ufeff/, '').trimStart().toLowerCase();
    if (head.startsWith('<svg') || ((head.startsWith('<?xml') || head.startsWith('<!--')) && head.includes('<svg')))
      return 'image/svg+xml';
  }
  const riff = decode(data.subarray(0, 4)) === 'RIFF';
  if (riff && decode(data.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (riff && decode(data.subarray(8, 12)) === 'WAVE') return 'audio/wav';
  if (decode(data.subarray(0, 4)) === 'OggS') return 'audio/ogg';
  if (decode(data.subarray(0, 4)) === 'fLaC') return 'audio/flac';
  if (
    decode(data.subarray(0, 3)) === 'ID3' ||
    (data.length > 3 &&
      data[0] === 0xff &&
      (data[1] & 0xe0) === 0xe0 &&
      (data[1] & 0x06) !== 0 &&
      (data[2] & 0xf0) !== 0xf0)
  )
    return 'audio/mpeg';
  if (decode(data.subarray(4, 8)) === 'ftyp' && /\.(m4a|mp4)$/i.test(name))
    return /\.m4a$/i.test(name) ? 'audio/mp4' : 'video/mp4';
  if (starts(data, [0x1a, 0x45, 0xdf, 0xa3]) && decode(data.subarray(0, 4096)).includes('webm'))
    return decode(data.subarray(0, 4096)).includes('OpusHead') &&
      !/V_VP[89]|V_AV1/.test(decode(data.subarray(0, 4096)))
      ? 'audio/webm'
      : 'video/webm';
  if (
    /\.(txt|md|markdown|csv|tsv|log|json|jsonl|ipynb|ya?ml|toml|ini|xml|html?|css|sql|py|tsx?|jsx?|sh|rs|c|cpp|h|tex)$/i.test(
      name,
    ) &&
    !data.includes(0) &&
    isUtf8(data)
  )
    return 'text/plain; charset=utf-8';
  if (decode(data.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  if (starts(data, [0x50, 0x4b, 0x03, 0x04])) {
    if (/\.docx$/i.test(name))
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (/\.xlsx$/i.test(name))
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (/\.pptx$/i.test(name))
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (/\.zip$/i.test(name)) return 'application/zip';
  }
  if (starts(data, [0x1f, 0x8b]) && /\.(?:gz|tgz|tar\.gz)$/i.test(name)) return 'application/gzip';
  return 'application/octet-stream';
}
