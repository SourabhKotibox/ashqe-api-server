/**
 * Check all users and their subscription data
 */

import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  email: String,
  name: String,
  subscriptionPlan: String,
  subscriptionStatus: String,
  subscriptionExpiry: Date,
  subscriptionPlanId: mongoose.Schema.Types.ObjectId,
  subscriptionPlanName: String,
});

const SubscriptionSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  status: String,
  plan: String,
  planId: mongoose.Schema.Types.ObjectId,
  endDate: Date,
});

const UserModel = mongoose.model('User', UserSchema);
const SubscriptionModel = mongoose.model('Subscription', SubscriptionSchema);

async function checkAllUsers() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ashqe';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Get all users
    const users = await UserModel.find({}).limit(5).lean();
    console.log(`Found ${users.length} users:`);
    
    for (const user of users) {
      console.log(`\nUser: ${user.email || user.name}`);
      console.log(`  subscriptionPlan: ${user.subscriptionPlan}`);
      console.log(`  subscriptionStatus: ${user.subscriptionStatus}`);
      console.log(`  subscriptionPlanName: ${user.subscriptionPlanName || 'NOT SET'}`);
      console.log(`  subscriptionPlanId: ${user.subscriptionPlanId || 'NOT SET'}`);
      
      // Check their subscriptions
      const subscriptions = await SubscriptionModel.find({ userId: user._id }).lean();
      console.log(`  Subscriptions count: ${subscriptions.length}`);
      if (subscriptions.length > 0) {
        subscriptions.forEach(sub => {
          console.log(`    - plan: ${sub.plan}, status: ${sub.status}, endDate: ${sub.endDate}`);
        });
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

checkAllUsers();
