const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const routes = require('./src/routes');

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/', (req, res) => res.send('OK'));

// API 라우트
app.use('/api', routes);

module.exports = app;
