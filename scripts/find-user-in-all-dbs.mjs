/**
 * Find the user in all databases
 */

import mongoose from 'mongoose';

async function findUserInAllDbs() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ashqe';
    // Connect without specifying database to access admin
    const conn = await mongoose.createConnection(mongoUri.replace(/\/[^/]+$/, '/'));
    console.log('Connected to MongoDB');

    const admin = conn.db.admin();
    const databases = await admin.listDatabases();
    
    const targetEmail = 'developerjai025@gmail.com';
    console.log(`Searching for user: ${targetEmail}\n`);

    for (const dbInfo of databases.databases) {
      const dbName = dbInfo.name;
      if (dbName === 'admin' || dbName === 'config' || dbName === 'local') continue;
      
      try {
        const db = conn.useDb(dbName);
        const usersCollection = db.collection('users');
        const user = await usersCollection.findOne({ email: targetEmail });
        
        if (user) {
          console.log(`✅ Found user in database: ${dbName}`);
          console.log(`   User ID: ${user._id}`);
          console.log(`   subscriptionPlan: ${user.subscriptionPlan}`);
          console.log(`   subscriptionPlanName: ${user.subscriptionPlanName || 'NOT SET'}`);
          console.log(`   subscriptionStatus: ${user.subscriptionStatus}`);
          
          // Check subscriptions
          const subscriptionsCollection = db.collection('subscriptions');
          const subscriptions = await subscriptionsCollection.find({ userId: user._id }).toArray();
          console.log(`   Active subscriptions: ${subscriptions.length}`);
          subscriptions.forEach(sub => {
            console.log(`     - plan: ${sub.plan}, status: ${sub.status}`);
          });
        }
      } catch (err) {
        // Skip databases we can't access
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

findUserInAllDbs();
