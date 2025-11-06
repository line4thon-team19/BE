const { getMysql } = require('../libs/mysqlClient');

async function getRandomBattleQuestions(limit = 5) {
  const pool = await getMysql();
  const [rows] = await pool.query(
    `SELECT
      id,
      sentence AS text, -- 문제 문장
      wrongSentence AS wrongText, -- 틀린 문장
      answer AS answer, -- 정답 문장
      explanation AS explanation -- 해설
    FROM BattleQuestion
    ORDER BY RAND()
    LIMIT ?`,
    [limit],
  );
  return rows;
}

module.exports = { getRandomBattleQuestions };
