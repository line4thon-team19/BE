const RAW = process.env.APP_KEY_PREFIX || '';
const PFX = RAW ? `${RAW}:` : '';

/* Battle Mode Keys */
function battleSession(sessionId) {
  return `${PFX}battle:session:${sessionId}`;
}
function battleRoomCode(roomCode) {
  return `${PFX}battle:roomcode:${roomCode}`;
}
function battleRoundWinner(sessionId, round) {
  return `${PFX}battle:session:${sessionId}:round:${round}:winner`;
}
function battleAnswerHash(sessionId, round, playerId) {
  return `${PFX}battle:session:${sessionId}:answers:${round}:${playerId}`;
}
function battleScore(sessionId) {
  return `${PFX}battle:session:${sessionId}:score`;
}

/* Practice Mode Keys */
function practiceSession(sessionId) {
  return `${PFX}practice:session:${sessionId}`;
}

module.exports = {
  battleSession,
  battleRoomCode,
  battleRoundWinner,
  battleAnswerHash,
  battleScore,
  practiceSession,
};
