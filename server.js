require('dotenv').config();
const http = require('http');
const app = require('./app');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

// socket.io 서버 생성 및 연결
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
