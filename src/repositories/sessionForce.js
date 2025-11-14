const {
  getPracticeSession,
  savePracticeSession,
} = require('./practiceSessionRepo');

const battleRepo = require('./battleSessionRepo');

async function getBattleSession(sessionId) {
  return battleRepo.getSession(sessionId);
}
async function saveBattleSession(sess) {
  return battleRepo.updateSession(sess.sessionId, { ...sess });
}

function guessKindById(sessionId) {
  if (typeof sessionId !== 'string') return null;
  if (sessionId.startsWith('p_')) return 'practice';
  if (sessionId.startsWith('b_')) return 'battle';
  return null;
}

function isEndedCompat(sess) {
  return (sess?.status === 'ended') || (sess?.state === 'ENDED');
}

/**
 * 강제 종료 수행 
 * @param {string} sessionId
 * @param {Object} [opts]
 * @param {'practice'|'battle'} [opts.kind]
 * @param {'user_force'|'server_error'|'timeout'|'admin_force'|string} [opts.endedReason='user_force']
 * @param {string} [opts.endedMessage]
 * @param {string} [opts.errorCode]
 * @param {string|null} [opts.requestUserId]     // 소유자/참가자 검증용
 * @param {boolean} [opts.bypassOwnerCheck=false]
 * @returns {Promise<{kind:string, status:'ended', sessionId:string, alreadyEnded:boolean, endedAt:string}>}
 */
async function forceEndSession(sessionId, opts = {}) {
  const kind = opts.kind || guessKindById(sessionId);
  if (!kind) throw new Error('Unknown session kind');

  const endedReason = opts.endedReason || 'user_force';
  const nowIso = new Date().toISOString();

  // ------------------------------- PRACTICE -------------------------------
  if (kind === 'practice') {
    const sess = await getPracticeSession(sessionId);
    if (!sess) {
      throw Object.assign(new Error('Session not found'), { status: 404 });
    }

    // 소유자 검증
    if (!opts.bypassOwnerCheck && sess.guestId && opts.requestUserId && sess.guestId !== opts.requestUserId) {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }

    const alreadyEnded = isEndedCompat(sess);

    if (!alreadyEnded) {
      sess.status = 'ended';

      sess.endedAt = nowIso;
      sess.endedBy = opts.requestUserId || 'system';
      sess.endedReason = endedReason;
      if (opts.errorCode)    sess.errorCode = opts.errorCode;
      if (opts.endedMessage) sess.endedMessage = opts.endedMessage;

      await savePracticeSession(sess);
    }

    return {
      kind,
      status: 'ended',
      sessionId,
      alreadyEnded,
      endedAt: sess.endedAt || nowIso,
    };
  }

  // -------------------------------- BATTLE --------------------------------
  if (kind === 'battle') {
    const sess = await getBattleSession(sessionId);
    if (!sess) {
      throw Object.assign(new Error('Session not found'), { status: 404 });
    }

    // 참가자 검증
    if (!opts.bypassOwnerCheck && opts.requestUserId) {
        const players = Array.isArray(sess.players) ? sess.players : [];
        const isHost = !!sess.hostId && sess.hostId === opts.requestUserId;
        const isPlayer = players.some(p => p?.playerId === opts.requestUserId);
        if (!isHost && !isPlayer) {
            throw Object.assign(new Error('Forbidden'), { status: 403 });
        }
    }

    const alreadyEnded = isEndedCompat(sess);

    if (!alreadyEnded) {
      sess.status = 'ended';

      sess.endedAt = nowIso;
      sess.endedBy = opts.requestUserId || 'system';
      sess.endedReason = endedReason;

      if (typeof opts.winner !== 'undefined') {
        sess.winner = opts.winner;
      }
      if (opts.errorCode)    sess.errorCode = opts.errorCode;
      if (opts.endedMessage) sess.endedMessage = opts.endedMessage;

      await saveBattleSession(sess);
    }

    return {
      kind,
      status: 'ended',
      sessionId,
      alreadyEnded,
      endedAt: sess.endedAt || nowIso,
    };
  }

  throw new Error('Unsupported kind');
}

module.exports = {
  forceEndSession,
  guessKindById,
  getBattleSession,
  saveBattleSession,
};
