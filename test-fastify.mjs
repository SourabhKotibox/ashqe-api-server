import Fastify from 'fastify';
const fastify = Fastify({ logger: false });

fastify.get('/share/:contentId', async (request, reply) => {
  const contentId = request.params.contentId;
  const webUrl = `https://ashqe.app/movie/${contentId}`;
  const androidIntent = `intent://movie/${contentId}`;
  
  return reply.send({
    success: true,
    data: {
      contentId,
      contentType: 'movie',
      webUrl,
      androidIntent,
    }
  });
});

fastify.inject({
  method: 'GET',
  url: '/share/6a6b36466eb5c0873a37863d'
}).then(res => {
  console.log("STATUS:", res.statusCode);
  console.log("BODY:", res.body);
});
