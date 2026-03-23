const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');

const { getMysql } = require('./src/libs/mysqlClient');
const { getRedis } = require('./src/libs/redisClient');
const routes = require('./src/routes');

const app = express();

async function getDependencyReadiness() {
  const [mysqlResult, redisResult] = await Promise.allSettled([
    getMysql().then((pool) => pool.query('SELECT 1')),
    getRedis().then((client) => client.ping()),
  ]);

  const dependencies = {
    mysql: mysqlResult.status === 'fulfilled' ? 'up' : 'down',
    redis: redisResult.status === 'fulfilled' ? 'up' : 'down',
  };

  return {
    ready: Object.values(dependencies).every((status) => status === 'up'),
    dependencies,
  };
}

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use(cors());

// 헬스체크
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/readyz', async (_req, res) => {
  const readiness = await getDependencyReadiness();
  const statusCode = readiness.ready ? 200 : 503;

  return res.status(statusCode).json({
    status: readiness.ready ? 'ready' : 'not_ready',
    ...readiness,
  });
});

// 기본 라우트
app.get('/', (_req, res) => res.send('OK'));

// API 라우트
app.use('/api', routes);

app.locals.getDependencyReadiness = getDependencyReadiness;

module.exports = app;
