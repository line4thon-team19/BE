function normalizeText(s) {
  return String(s || '')
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/[\s\u200B-\u200D\uFEFF]/g, ' ')
  .replace(/\s+/g, ' ');
}

module.exports = {
  normalizeText,
};