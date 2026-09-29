import fastifyApp from './dist/index.mjs';

async function runTest() {
  console.log("Starting test...");
  try {
    const response = await fastifyApp.inject({
      method: 'GET',
      url: '/api/.well-known/assetlinks.json'
    });
    console.log("STATUS:", response.statusCode);
    console.log("BODY:", response.body);
  } catch (err) {
    console.error("Test Failed:", err);
  } finally {
    process.exit(0);
  }
}
runTest();
