import Fastify from 'fastify';
const fastify = Fastify({ logger: false });

fastify.get('/share/:contentId', async (request, reply) => {
  const format = request.query.format;
  const acceptsJson = request.headers.accept?.includes('application/json') || format === 'json';

  if (acceptsJson) {
    return reply.send({ success: true, data: { isJson: true } });
  }

  const html = `<!DOCTYPE html><html><body>HTML</body></html>`;
  return reply.type('text/html').send(html);
});

fastify.inject({
  method: 'GET',
  url: '/share/123?format=json'
}).then(res => {
  console.log("STATUS:", res.statusCode);
  console.log("BODY:", res.body);
});
