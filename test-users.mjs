import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { UserModel } from './dist/models/User.js';

dotenv.config();
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const c = await UserModel.countDocuments();
  console.log("CURRENT USERS:", c);
  process.exit(0);
});
