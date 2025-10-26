require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');

const routes = require('./src/routes');
const battleRoute = require('./src/routes/battle.route');

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use(cors());

// 헬스체크
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/readyz', (_req, res) => res.status(200).send('ready'));

// 기본 라우트
app.get('/', (_req, res) => res.send('OK'));

// API 라우트
app.use('/api', routes);
app.use('/api/battle', battleRoute);

module.exports = app;
