// Tiny language helpers shared by the game and the runners. DOM-free, no imports.
// English only: a small local model can drift into another script; such a line never reaches the table. Of the letters in a
// text, at least LATIN_SHARE must be Latin script (A-Z with accents).
export const LATIN_SHARE = 0.8;
export function notEnglish(s) {
  const t = String(s == null ? '' : s), letters = t.match(/\p{L}/gu);
  if (!letters || letters.length < 3) return false;
  let latin = 0; for (const c of letters) if (/[A-Za-zÀ-ɏ]/.test(c)) latin++;
  return latin / letters.length < LATIN_SHARE;
}
