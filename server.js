require('dotenv').config();
const http = require('http');
const path = require('path');
const app = require('./app');
const { Server } = require('socket.io');

const swaggerUi = require('swagger-ui-express');
const $RefParser = require('@apidevtools/json-schema-ref-parser');

const notFound = require('./src/middlewares/notFound');
const errorHandler = require('./src/middlewares/errorHandler');

const PORT = process.env.PORT || 3000;
const ENABLE_SWAGGER = process.env.ENABLE_SWAGGER === 'true';

(async () => {
   try {
    if (ENABLE_SWAGGER) {
      const root = path.join(__dirname, 'src/docs/openapi.yaml');
      const bundled = await $RefParser.bundle(root);
      app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(bundled));
      app.get('/api/docs.json', (_req, res) => res.json(bundled));
      console.log('Swagger UI enabled at:', `http://localhost:${PORT}/api/docs`);
    } else {
      console.log('Swagger UI disabled. Set ENABLE_SWAGGER=true to enable.');
    }
  } catch (e) {
    console.error('Swagger bundle failed:', e);
  }

  app.use(notFound);
  app.use(errorHandler);

    // HTTP 서버 + socket.io
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*', // 개발 단계에서는 전체 허용
      methods: ['GET', 'POST'],
    },
  });

  // 연결 이벤트
  io.on('connection', (socket) => {
    console.log('[socket.io] connected:', socket.id);

    // 연결 해제 로그
    socket.on('disconnect', (reason) => {
      console.log('[socket.io] disconnected:', socket.id, 'reason:', reason);
    });
  });

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
})();
