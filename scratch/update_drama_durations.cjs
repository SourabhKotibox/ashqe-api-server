const mongoose = require('mongoose');
mongoose.connect('mongodb://localhost:27017/triple-mindes').then(async () => {
  const db = mongoose.connection.db;
  const dramas = await db.collection('contents').find({ contentType: 'drama' }).toArray();
  let updatedCount = 0;
  for (const drama of dramas) {
    const episodes = await db.collection('episodes').find({ contentId: drama._id }).toArray();
    for (const ep of episodes) {
      const newDuration = Math.floor(Math.random() * 20) + 40;
      await db.collection('episodes').updateOne({ _id: ep._id }, { $set: { duration: newDuration } });
      updatedCount++;
    }
  }
  console.log('Updated episodes for dramas:', updatedCount);
  mongoose.disconnect();
}).catch(console.error);
