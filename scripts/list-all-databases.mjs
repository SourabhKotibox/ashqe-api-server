/**
 * List all databases and collections
 */

import mongoose from 'mongoose';

async function listDatabases() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ashqe';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const admin = mongoose.connection.db.admin();
    const databases = await admin.listDatabases();
    
    console.log('Available databases:');
    databases.databases.forEach(db => {
      console.log(`  - ${db.name} (size: ${db.sizeOnDisk})`);
    });

    // Check current database
    const currentDb = mongoose.connection.db;
    console.log(`\nCurrent database: ${currentDb.databaseName}`);
    
    // List collections in current database
    const collections = await currentDb.listCollections().toArray();
    console.log('Collections in current database:');
    collections.forEach(col => {
      console.log(`  - ${col.name}`);
    });

    // Count users in current database
    const usersCount = await currentDb.collection('users').countDocuments();
    console.log(`\nUsers count in current database: ${usersCount}`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

listDatabases();
