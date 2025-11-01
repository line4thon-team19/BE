function maskText(str, { mode = 'mask', keepTail = 2 } = {}) {
  if (!str) return '';
  if (mode === 'length') return `len=${str.length}`;
  if (mode === 'none') return '';
  if (str.length <= keepTail) return '*'.repeat(Math.max(0, str.length - 1)) + str.slice(-1);
  return '*'.repeat(str.length - keepTail) + str.slice(-keepTail);
}

function normalizeText(s) {
  return (s || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function rateLimiter({ windowMs = 300, max = 1 } = {}) {
  const bucket = new Map();
  return {
    allow(id) {
      const now = Date.now();
      const item = bucket.get(id);
      if (!item || item.resetAt <= now) {
        bucket.set(id, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (item.count < max) {
        item.count += 1;
        return true;
      }
      return false;
    },
  };
}

module.exports = { maskText, normalizeText, rateLimiter };
