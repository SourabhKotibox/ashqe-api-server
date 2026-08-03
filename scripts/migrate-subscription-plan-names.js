/**
 * Migration script to populate subscriptionPlanName for existing users
 * This script updates existing user documents to include the actual plan name
 * from their active subscription or from the subscription plan collection.
 */

import mongoose from 'mongoose';
import { UserModel } from '../dist/models/User';
import { SubscriptionModel } from '../dist/models/Subscription';
import { SubscriptionPlanModel } from '../dist/models/SubscriptionPlan';

async function migrateSubscriptionPlanNames() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ashqe';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Find all users with active subscriptions but missing subscriptionPlanName
    const usersWithoutPlanName = await UserModel.find({
      subscriptionStatus: 'active',
      subscriptionPlan: { $ne: 'free' },
      subscriptionPlanName: { $exists: false }
    }).lean();

    console.log(`Found ${usersWithoutPlanName.length} users to migrate`);

    let updatedCount = 0;
    let skippedCount = 0;

    for (const user of usersWithoutPlanName) {
      try {
        // First, try to get the plan name from active subscription
        const liveSub = await SubscriptionModel.findOne({
          userId: user._id,
          status: 'active',
          $or: [
            { endDate: { $gte: new Date() } },
            { endDate: null },
            { endDate: { $exists: false } }
          ]
        }).sort({ endDate: -1 }).lean();

        let planName = null;

        if (liveSub && liveSub.plan) {
          planName = liveSub.plan;
        } else if (user.subscriptionPlanId) {
          // Fallback: get plan name from subscriptionPlanId
          const plan = await SubscriptionPlanModel.findById(user.subscriptionPlanId).lean();
          if (plan) {
            planName = plan.name;
          }
        }

        if (planName) {
          await UserModel.findByIdAndUpdate(user._id, {
            $set: { subscriptionPlanName: planName }
          });
          console.log(`Updated user ${user.email}: ${planName}`);
          updatedCount++;
        } else {
          console.log(`Skipped user ${user.email}: no plan name found`);
          skippedCount++;
        }
      } catch (error) {
        console.error(`Error migrating user ${user.email}:`, error);
        skippedCount++;
      }
    }

    console.log(`Migration complete: ${updatedCount} updated, ${skippedCount} skipped`);
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run the migration
migrateSubscriptionPlanNames();
