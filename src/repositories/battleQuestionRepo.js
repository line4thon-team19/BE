const { getMysql } = require('../libs/mysqlClient');

async function getRandomBattleQuestions(limit = 5) {
  const pool = await getMysql();
  const [rows] = await pool.query(
    `SELECT id, sentence AS text, wrongSentence AS wrongText
     FROM BattleQuestion
     ORDER BY RAND()
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    text: r.text,
    wrongText: r.wrongText ?? null,
  }));
}

module.exports = { getRandomBattleQuestions };
