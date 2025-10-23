const express = require('express');
const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '24h';

if (!JWT_SECRET) {
  console.warn('JWT_SECRET is not set in .env file.');
}

router.post('/', (req, res) => {
  try {
    const playerId = `plr_${nanoid(12)}`;

    // JWT 발급 (sub=playerId)
    const issuedAtSec = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      { sub: playerId, role: 'guest', iat: issuedAtSec },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES } 
    );

    // 만료 시간 ISO 문자열
    const decoded = jwt.decode(token);
    const expSec = typeof decoded?.exp === 'number' ? decoded.exp : issuedAtSec;
    const expiresAt = new Date(expSec * 1000).toISOString();

    return res.status(200).json({
      playerId,
      guestToken: token,
      expiresAt,
    });
  } catch (err) {
    console.error('[POST /api/guest] error:', err);
    return res.status(500).json({ message: 'Failed to issue guest token' });
  }
});

module.exports = router;
