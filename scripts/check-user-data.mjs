/**
 * Check current user subscription data
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

async function checkUserData() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ashqe';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Check the specific user from the API response
    const user = await UserModel.findOne({ email: 'developerjai025@gmail.com' }).lean();
    console.log('User data:', JSON.stringify(user, null, 2));

    // Check their subscriptions
    const subscriptions = await SubscriptionModel.find({ userId: user._id }).lean();
    console.log('User subscriptions:', JSON.stringify(subscriptions, null, 2));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

checkUserData();
