const { getMysql } = require('../libs/mysqlClient');

async function getRandomQuestions(limit = 5) {
  const pool = await getMysql();
  const [rows] = await pool.query(
    `SELECT id, sentence, choice1, choice2, answer AS answerLabel, explanation
     FROM PracticeQuestion
     ORDER BY RAND()
     LIMIT ?`,
    [limit]
  );
  return rows;
}

module.exports = { getRandomQuestions };
