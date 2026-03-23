const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('JWT_SECRET is not set in .env file.');
}

function createUnauthorizedError(message) {
  const error = new Error(message);
  error.status = 401;
  return error;
}

// 빈 문자열을 제거하고 토큰 값을 정리
function normalizeToken(token) {
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

// Authorization 헤더에서 Bearer 토큰만 추출
function extractBearerToken(authorizationHeader = '') {
  const [scheme, token] = String(authorizationHeader).split(' ');

  if (!scheme || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  return normalizeToken(token);
}

// 게스트 JWT를 검증해 애플리케이션 사용자 정보로 변환
function verifyGuestToken(token) {
  const normalizedToken = normalizeToken(token);

  if (!normalizedToken) {
    throw createUnauthorizedError('Unauthorized: token missing');
  }

  if (!JWT_SECRET) {
    throw createUnauthorizedError('Unauthorized: token verification unavailable');
  }

  try {
    const decoded = jwt.verify(normalizedToken, JWT_SECRET);
    return {
      playerId: decoded.sub,
      role: decoded.role || 'guest',
    };
  } catch (_error) {
    throw createUnauthorizedError('Unauthorized: invalid or expired token');
  }
}

// Socket handshake의 위치에서 토큰을 찾아 반환
function resolveSocketToken(socket) {
  return (
    normalizeToken(socket.handshake.auth?.token) ||
    normalizeToken(socket.handshake.auth?.guestToken) ||
    extractBearerToken(socket.handshake.auth?.authorization || '') ||
    extractBearerToken(socket.handshake.headers?.authorization || '') ||
    normalizeToken(socket.handshake.query?.token)
  );
}

// HTTP 요청의 Bearer 토큰을 검증(req.user 판별)
function authenticateGuest(req, res, next) {
  try {
    const token = extractBearerToken(req.headers.authorization || '');
    req.user = verifyGuestToken(token);
    return next();
  } catch (error) {
    return res.status(error.status || 401).json({
      message: error.message || 'Unauthorized: invalid or expired token',
    });
  }
}

authenticateGuest.extractBearerToken = extractBearerToken;
authenticateGuest.verifyGuestToken = verifyGuestToken;
authenticateGuest.resolveSocketToken = resolveSocketToken;

module.exports = authenticateGuest;
