import mongoose from 'mongoose';

async function run() {
  await mongoose.connect('mongodb://localhost:27017/triple-mindes');
  console.log('Connected to DB');

  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const col of collections) {
    const name = col.name;
    const items = await mongoose.connection.collection(name).find({}).toArray();
    for (const item of items) {
      const str = JSON.stringify(item);
      if (str.includes('6a346322e93806fc13d0582e') || str.includes('90s-bollywood')) {
        console.log(`Found in collection "${name}":`, JSON.stringify(item, null, 2));
      }
    }
  }

  await mongoose.disconnect();
}

run().catch(console.error);
