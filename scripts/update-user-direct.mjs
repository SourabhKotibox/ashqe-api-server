/**
 * Direct MongoDB update to add subscriptionPlanName
 */

import mongoose from 'mongoose';

async function updateUserDirect() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ashqe';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Get the database
    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');
    const subscriptionsCollection = db.collection('subscriptions');

    // Find the user by email
    const user = await usersCollection.findOne({ email: 'developerjai025@gmail.com' });
    console.log('Found user:', user ? user.email : 'Not found');

    if (user) {
      // Find their active subscription
      const subscription = await subscriptionsCollection.findOne({
        userId: user._id,
        status: 'active'
      });
      
      console.log('Active subscription:', subscription ? subscription.plan : 'Not found');

      if (subscription && subscription.plan) {
        // Update the user with the plan name
        const result = await usersCollection.updateOne(
          { _id: user._id },
          { $set: { subscriptionPlanName: subscription.plan } }
        );
        console.log('Update result:', result);
      } else {
        console.log('No active subscription found');
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

updateUserDirect();
