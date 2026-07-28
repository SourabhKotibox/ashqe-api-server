import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkLatestMovie() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/triple-mindes');
  
  const movie = await mongoose.connection.collection('movies').find().sort({ createdAt: -1 }).limit(1).toArray();
  
  console.log(JSON.stringify(movie, null, 2));
  
  mongoose.disconnect();
}

checkLatestMovie().catch(console.error);
