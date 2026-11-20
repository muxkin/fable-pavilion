/** Accept grouped clipboard codes without letting maxlength truncate the sixth digit. */
export function pasteLoginCode(event: ClipboardEvent) {
  const code = event.clipboardData?.getData('text').replace(/\s/g, '');
  if (code && /^[0-9]{6}$/.test(code)) {
    event.preventDefault();
    (event.currentTarget as HTMLInputElement).value = code;
  }
}
