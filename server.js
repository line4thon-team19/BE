require('dotenv').config();
const http = require('http');
const path = require('path');
const { initSocket } = require('./src/socket');

const swaggerUi = require('swagger-ui-express');
const $RefParser = require('@apidevtools/json-schema-ref-parser');

const notFound = require('./src/middlewares/notFound');
const errorHandler = require('./src/middlewares/errorHandler');

const app = require('./app');

const PORT = Number(process.env.PORT || 3000);
const ENABLE_SWAGGER = String(process.env.ENABLE_SWAGGER).toLowerCase() === 'true';

async function warmUpDependencies() {
  if (typeof app.locals.getDependencyReadiness !== 'function') {
    return;
  }

  const readiness = await app.locals.getDependencyReadiness();

  if (readiness.ready) {
    console.log('[Ready] dependencies ready at startup');
    return;
  }

  console.warn('[Ready] dependencies not ready at startup:', readiness.dependencies);
}

(async () => {
  try {
    if (ENABLE_SWAGGER) {
      const root = path.join(__dirname, 'src/docs/openapi.yaml');
      let bundled = await $RefParser.bundle(root);

      bundled.servers = [{ url: '/', description: 'Current host' }];

      app.get('/api/docs.json', (_req, res) => {
        res.set({
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
          'Surrogate-Control': 'no-store',
          'Content-Type': 'application/json',
        });
        res.json(bundled);
      });

      app.use(
        '/api/docs',
        swaggerUi.serve,
        swaggerUi.setup(undefined, {
          swaggerOptions: { url: '/api/docs.json?v=2' },
        }),
      );

      console.log('[Swagger] enabled:', `http://localhost:${PORT}/api/docs`);
    } else {
      console.log('[Swagger] disabled. Set ENABLE_SWAGGER=true to enable.');
    }
  } catch (e) {
    console.error('[Swagger] bundle failed:', e);
  }

  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);
  const io = initSocket(server);
  app.locals.io = io;

  await warmUpDependencies();

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
})();
