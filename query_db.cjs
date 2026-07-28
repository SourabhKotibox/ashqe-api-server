const mongoose = require('mongoose');
const uri = "mongodb://localhost:27017/triple-mindes";

async function run() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const sections = await db.collection('sections').find({}).toArray();
  const movies = await db.collection('movies').countDocuments();
  const contents = await db.collection('contents').countDocuments();
  console.log('Sections:', sections.length);
  console.log('Movies:', movies);
  console.log('Contents:', contents);
  process.exit(0);
}
run();
