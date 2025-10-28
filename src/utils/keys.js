const RAW = process.env.APP_KEY_PREFIX || ''; 
const PFX = RAW ? `${RAW}:` : ''; 

function battleSession(sessionId)  { return `${PFX}battle:session:${sessionId}`; }
function battleRoomCode(roomCode)  { return `${PFX}battle:roomcode:${roomCode}`; }
function practiceSession(sessionId){ return `${PFX}practice:session:${sessionId}`; }

module.exports = { battleSession, battleRoomCode, practiceSession };
