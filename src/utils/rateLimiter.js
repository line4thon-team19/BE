// 메모리 기반의 간단한 호출 제한기를 생성
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

module.exports = {
  rateLimiter,
};
