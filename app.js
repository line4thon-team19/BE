const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const routes = require('./src/routes');
const notFound = require('./src/middlewares/notFound');
const errorHandler = require('./src/middlewares/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/', (req, res) => res.send('OK'));

// API 라우트
app.use('/api', routes);

// 에러 핸들러
app.use(notFound);
app.use(errorHandler);

module.exports = app;
