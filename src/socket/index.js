const { Server } = require('socket.io');
const battleSocket = require('./modules/battle');

function parseOrigins(envValue) {
  return (envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function initSocket(httpServer) {
  const DEFAULT_ORIGINS = [
    'https://hyunseoko.store',
    'http://localhost:3000',
    'http://localhost:5500', // 정적 테스트
  ];
  const ALLOWED_ORIGINS = parseOrigins(process.env.SOCKET_CORS_ORIGINS)?.length
    ? parseOrigins(process.env.SOCKET_CORS_ORIGINS)
    : DEFAULT_ORIGINS;

  const io = new Server(httpServer, {
    path: '/ws', // Nginx location과 일치해야
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket'],
    pingInterval: 25_000,
    pingTimeout: 60_000,
    maxHttpBufferSize: 1e6, // 1MB
    perMessageDeflate: {
      threshold: 1024,
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 120_000,
    },
  });

  io.use(async (socket, next) => {
    try {
      const raw = socket.handshake.auth?.playerId;
      const safe =
        typeof raw === 'string' && raw.trim().length > 0
          ? raw.trim().slice(0, 40)
          : `plr_${socket.id.slice(-6)}`;
      socket.data.playerId = safe;

      return next();
    } catch (e) {
      return next(e);
    }
  });

  io.on('connection', (socket) => {
    battleSocket.register(io, socket);

    console.log('[socket.io] connected:', socket.id);

    socket.on('disconnect', (reason) => {
      console.log('[socket.io] disconnected:', socket.id, 'reason:', reason);
    });
  });

  return io;
}

module.exports = { initSocket };
