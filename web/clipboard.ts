/** Clipboard access may be unavailable in a restricted WebView or browser policy. */
export async function copyText(value: string): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error();
    await navigator.clipboard.writeText(value);
  } catch { throw new Error("Copy failed. Select and copy the text."); }
}
