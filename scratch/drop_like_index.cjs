const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb://localhost:27017/triple-mindes';

async function main() {
  await mongoose.connect(MONGODB_URI);

  const collection = mongoose.connection.collection('userlikes');
  
  try {
    console.log('Attempting to drop unique index "userId_1_contentId_1" from userlikes collection...');
    await collection.dropIndex('userId_1_contentId_1');
    console.log('Successfully dropped the index!');
  } catch (err) {
    console.log('Error dropping index (it might not exist or already be dropped):', err.message);
  }

  // Verify indexes
  const indexes = await collection.indexes();
  console.log('\n=== CURRENT INDEXES ===');
  console.log(JSON.stringify(indexes, null, 2));

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
