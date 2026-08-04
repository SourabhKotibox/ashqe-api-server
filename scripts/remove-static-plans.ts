import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGODB_URI;
mongoose.connect(uri).then(async () => {
  const db = mongoose.connection.db;
  const result = await db.collection('subscriptionplans').deleteMany({
    name: { $in: ['Free', 'Basic', 'Standard', 'Premium'] }
  });
  console.log('Deleted static plans:', result.deletedCount);
  process.exit(0);
});
