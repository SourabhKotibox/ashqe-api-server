import fastifyApp from './dist/index.mjs';

async function runTest() {
  console.log("Starting test...");
  try {
    const response = await fastifyApp.inject({
      method: 'GET',
      url: '/api/share/6ab6c09519ad15156fa5e78a'
    });
    console.log("STATUS:", response.statusCode);
    console.log("HEADERS:", response.headers);
    console.log("BODY START: ---");
    console.log(response.body.substring(0, 200));
    console.log("--- BODY END");
  } catch (err) {
    console.error("Test Failed:", err);
  } finally {
    process.exit(0);
  }
}
runTest();
