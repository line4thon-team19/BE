const RAW = process.env.APP_KEY_PREFIX || '';
const PFX = RAW ? `${RAW}:` : '';

/* Battle Mode Keys */
function battleSession(sessionId) {
  return `${PFX}battle:session:${sessionId}`; // 세션 전체 정보(JSON)
}
function battleSessionState(sessionId) {
  return `${PFX}battle:session:state:${sessionId}`; // 실시간 상태 정보(HASH)
}
function battleRoomCode(roomCode) {
  return `${PFX}battle:roomcode:${roomCode}`;
}
function battleRoundWinner(sessionId, round) {
  return `${PFX}battle:session:${sessionId}:round:${round}:winner`;
}
function battleRoundAnswer(sessionId, round) {
  return `${PFX}battle:session:${sessionId}:round:${round}`;
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
  battleSessionState,
  battleRoomCode,
  battleRoundWinner,
  battleRoundAnswer,
  battleScore,
  practiceSession,
};
