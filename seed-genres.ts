import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI!;

const GENRES = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Horror',
  'Romance',
  'Thriller',
  'Sci-Fi',
  'Fantasy',
  'Crime',
  'Family',
  'Animation',
  'Documentary',
  'Mystery',
  'War',
  'History',
];

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log('db:', db.databaseName);

  for (const name of GENRES) {
    await db.collection('genres').updateOne(
      { name: { $regex: new RegExp(`^${name}$`, 'i') } },
      {
        $set: {
          name,
          active: true,
          status: 'published',
          updatedAt: new Date(),
        },
        $setOnInsert: {
          description: `${name} movies on Tataiya`,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  const all = await db.collection('genres').find({}).project({ name: 1, active: 1, status: 1 }).toArray();
  console.log('genres:', all.map((g) => `${g.name} (${g.status}/${g.active})`).join(', '));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
