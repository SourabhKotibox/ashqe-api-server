import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { UserModel } from './dist/models/User.js';

dotenv.config();

const run = async () => {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    
    const currentCount = await UserModel.countDocuments();
    const targetCount = 300;
    
    if (currentCount >= targetCount) {
      console.log(`You already have ${currentCount} users. No need to add more to reach 300.`);
      process.exit(0);
    }
    
    const needed = targetCount - currentCount;
    console.log(`Current users: ${currentCount}. Adding ${needed} fake users...`);
    
    const fakeUsers = [];
    const firstNames = ['Aarav', 'Vihaan', 'Vivaan', 'Ananya', 'Diya', 'Advik', 'Kabir', 'Anaya', 'Aarohi', 'Priya', 'Rahul', 'Amit', 'Neha', 'Rohan', 'Sneha', 'Karan', 'Pooja', 'Vikram', 'Riya', 'Sameer'];
    const lastNames = ['Sharma', 'Verma', 'Gupta', 'Patel', 'Singh', 'Kumar', 'Das', 'Joshi', 'Yadav', 'Mishra'];
    
    for (let i = 0; i < needed; i++) {
      const fName = firstNames[Math.floor(Math.random() * firstNames.length)];
      const lName = lastNames[Math.floor(Math.random() * lastNames.length)];
      const randomNum = Math.floor(Math.random() * 90000) + 10000;
      
      const email = `${fName.toLowerCase()}.${lName.toLowerCase()}${randomNum}@gmail.com`;
      
      fakeUsers.push({
        name: `${fName} ${lName}`,
        email: email,
        phone: `+919${Math.floor(Math.random() * 900000000) + 100000000}`, // random Indian phone number
        subscriptionPlan: 'free',
        subscriptionStatus: 'active',
        status: 'active',
        profiles: [{
          name: `${fName} ${lName}`,
          isKids: false,
          language: 'Hindi',
          maturityLevel: 18
        }],
        loginCount: Math.floor(Math.random() * 10),
        createdAt: new Date(Date.now() - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000)), // random time in last 30 days
      });
    }
    
    await UserModel.insertMany(fakeUsers);
    console.log(`Successfully added ${needed} fake users! You now have ${targetCount} users.`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

run();
