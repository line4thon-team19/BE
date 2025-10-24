const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('JWT_SECRET is not set in .env file.');
}

module.exports = function authenticateGuest(req, res, next) {
  const auth = req.headers.authorization || '';
  const [, token] = auth.split(' ');
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized: token missing' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // 게스트 발급 로직과 동일하게 sub=playerId 사용
    req.user = { playerId: decoded.sub, role: decoded.role || 'guest' };
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Unauthorized: invalid or expired token' });
  }
};
