const { nanoid, customAlphabet } = require('nanoid');

const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const genRoomCode = customAlphabet(ROOM_ALPHABET, 6);

function newBattleSessionId() {
  return `b_${nanoid(8)}`; // 배틀 전용 세션
}

module.exports = { genRoomCode, newBattleSessionId };
