import Fastify from 'fastify';
import shareRoutes from './src/routes/share';

const app = Fastify();
app.register(shareRoutes, { prefix: '/api' });

// Mock resolveContent to avoid DB
jest = require('jest-mock');
const mockResolve = jest.fn().mockResolvedValue({ type: 'Movie' });
require('./src/lib/contentResolver').resolveContent = mockResolve;
// We also need to mock incrementShareCount since it hits DB, but we can just let it fail silently as it has a try/catch.

app.inject({
  method: 'GET',
  url: '/api/share/123?format=json'
}).then(res => {
  console.log("STATUS:", res.statusCode);
  console.log("BODY:", res.body.substring(0, 100));
});
