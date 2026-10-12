import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Resolve MongoDB URI
function getMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const envPaths = [
    path.join(__dirname, '../.env'),
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), 'ashqe-api-server/.env')
  ];

  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('MONGODB_URI=') && !trimmed.startsWith('#')) {
          return trimmed.replace('MONGODB_URI=', '').trim().replace(/^['"]|['"]$/g, '');
        }
      }
    }
  }

  return 'mongodb+srv://tophillmovies_db_user:1FIKpXSJjKS272uS@cluster0.pdh6cp6.mongodb.net/ashqe?retryWrites=true&w=majority';
}

function ensureAshqeDb(rawUri) {
  try {
    const url = new URL(rawUri);
    const pathname = url.pathname.replace(/^\//, '');
    if (!pathname || pathname === 'test' || pathname === 'tataiya') {
      url.pathname = '/ashqe';
      return url.toString();
    }
    return rawUri;
  } catch {
    if (/\.mongodb\.net\/(\?|$)/.test(rawUri)) {
      return rawUri.replace(/\.mongodb\.net\/(\?|$)/, '.mongodb.net/ashqe$1');
    }
    return rawUri;
  }
}

// 2. Realistic Indian User Data Generators
const FIRST_NAMES_MALE = [
  'Aarav', 'Vihaan', 'Vivaan', 'Advik', 'Kabir', 'Rahul', 'Amit', 'Rohan', 'Karan', 'Vikram',
  'Sameer', 'Aditya', 'Arjun', 'Varun', 'Nikhil', 'Siddharth', 'Kunal', 'Gaurav', 'Manish',
  'Harshit', 'Raj', 'Abhishek', 'Ayush', 'Mohit', 'Deepak', 'Akash', 'Rohit', 'Suraj',
  'Yash', 'Pankaj', 'Sachin', 'Ankit', 'Vivek', 'Suresh', 'Manoj', 'Dinesh', 'Ajay', 'Vishal',
  'Naveen', 'Rakesh', 'Sanjay', 'Sunil', 'Pradeep', 'Ashok', 'Mahesh', 'Rajesh', 'Vinod', 'Anil'
];

const FIRST_NAMES_FEMALE = [
  'Ananya', 'Diya', 'Anaya', 'Aarohi', 'Priya', 'Neha', 'Sneha', 'Pooja', 'Riya', 'Simran',
  'Shreya', 'Megha', 'Kriti', 'Tanvi', 'Ishita', 'Divya', 'Sanya', 'Pallavi', 'Swati',
  'Sonali', 'Rashi', 'Preeti', 'Natasha', 'Shruti', 'Kavita', 'Ritu', 'Anjali', 'Komal',
  'Jyoti', 'Shikha', 'Bhavna', 'Meera', 'Nandini', 'Payal', 'Sakshi', 'Monika', 'Deepika', 'Aarti'
];

const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Patel', 'Singh', 'Kumar', 'Das', 'Joshi', 'Yadav', 'Mishra',
  'Chauhan', 'Jain', 'Bhatia', 'Agarwal', 'Malhotra', 'Kapoor', 'Saxena', 'Tiwari', 'Pandey', 'Mehta',
  'Shah', 'Reddy', 'Nair', 'Rao', 'Choudhary', 'Sengupta', 'Banerjee', 'Gill', 'Sethi', 'Dubey',
  'Bhardwaj', 'Shukla', 'Tripathi', 'Thakur', 'Goyal', 'Bansal', 'Garg', 'Chopra', 'Dewan', 'Bose'
];

const DEVICES = [
  'Redmi Note 12', 'Samsung Galaxy M34', 'Realme 11 Pro', 'Vivo V29', 'OnePlus Nord CE 3',
  'iPhone 14', 'Motorola G54', 'Chrome / Android', 'Oppo Reno 10', 'Poco X5 Pro',
  'Samsung Galaxy A14', 'Vivo Y200', 'OnePlus 11R', 'Redmi 12 5G', 'Realme Narzo 60'
];

const EMAIL_DOMAINS = ['gmail.com', 'gmail.com', 'gmail.com', 'yahoo.com', 'outlook.com', 'icloud.com'];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateIndianPhone() {
  const prefix = randomChoice(['9', '8', '7', '6']);
  let rest = '';
  for (let i = 0; i < 9; i++) {
    rest += Math.floor(Math.random() * 10);
  }
  return prefix + rest;
}

async function seedFakeUsers() {
  const TARGET_TOTAL = 536;
  const rawUri = getMongoUri();
  const uri = ensureAshqeDb(rawUri);

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
  });
  console.log(`Connected to database: "${mongoose.connection.name}"`);

  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection failed');

  const currentCount = await db.collection('users').countDocuments();
  console.log(`Current existing users in database: ${currentCount}`);

  if (currentCount >= TARGET_TOTAL) {
    console.log(`Database already has ${currentCount} users (target is ${TARGET_TOTAL}).`);
    console.log('No new fake users need to be added. Existing real users are 100% preserved!');
    await mongoose.disconnect();
    process.exit(0);
  }

  const needed = TARGET_TOTAL - currentCount;
  console.log(`Target total: ${TARGET_TOTAL}. Adding exactly ${needed} realistic users.`);
  console.log('All existing users will remain 100% untouched!\n');

  // Load existing emails and phones to avoid any collision
  const existingUsers = await db.collection('users').find({}, { projection: { email: 1, phone: 1 } }).toArray();
  const usedEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase()));
  const usedPhones = new Set(existingUsers.map(u => (u.phone || '')));

  const newUsers = [];
  const now = Date.now();
  const sixMonthsAgo = now - 180 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < needed; i++) {
    // Generate unique phone
    let phone = generateIndianPhone();
    while (usedPhones.has(`+91${phone}`) || usedPhones.has(phone)) {
      phone = generateIndianPhone();
    }
    usedPhones.add(`+91${phone}`);

    // ~40% OTP User (e.g. "User" with "<phone>@temp.local" matching Ashqe mobile OTP)
    // ~60% Full Profile (Real Name with personal email)
    const isOtpPhoneUser = Math.random() < 0.40;

    let name = 'User';
    let email = '';

    if (isOtpPhoneUser) {
      email = `${phone}@temp.local`.toLowerCase();
      let salt = 1;
      while (usedEmails.has(email)) {
        email = `${phone}_${salt}@temp.local`.toLowerCase();
        salt++;
      }
      usedEmails.add(email);
    } else {
      const isMale = Math.random() > 0.45;
      const firstName = isMale ? randomChoice(FIRST_NAMES_MALE) : randomChoice(FIRST_NAMES_FEMALE);
      const lastName = randomChoice(LAST_NAMES);
      name = `${firstName} ${lastName}`;

      const domain = randomChoice(EMAIL_DOMAINS);
      const separator = randomChoice(['.', '_', '']);
      const numSuffix = randomChoice(['', randomInt(1, 99), randomInt(1985, 2005)]);
      let baseEmail = `${firstName.toLowerCase()}${separator}${lastName.toLowerCase()}${numSuffix}@${domain}`;
      let salt = 1;
      while (usedEmails.has(baseEmail.toLowerCase())) {
        baseEmail = `${firstName.toLowerCase()}${separator}${lastName.toLowerCase()}${randomInt(10, 9999)}@${domain}`;
        salt++;
      }
      email = baseEmail.toLowerCase();
      usedEmails.add(email);
    }

    // Realistic plan distribution:
    // 50% free, 30% Silver, 20% Gold
    const planRoll = Math.random();
    let subscriptionPlan = 'free';
    let subscriptionPlanName = 'Free Plan';
    let subscriptionExpiry = null;

    if (planRoll < 0.50) {
      subscriptionPlan = 'free';
      subscriptionPlanName = 'Free Plan';
    } else if (planRoll < 0.80) {
      subscriptionPlan = 'Silver';
      subscriptionPlanName = 'Silver Plan';
      subscriptionExpiry = new Date(now + randomInt(15, 180) * 24 * 60 * 60 * 1000);
    } else {
      subscriptionPlan = 'Gold';
      subscriptionPlanName = 'Gold VIP Plan';
      subscriptionExpiry = new Date(now + randomInt(60, 365) * 24 * 60 * 60 * 1000);
    }

    // Realistic watch time in minutes (displays as hrs on dashboard)
    // 40% zero hrs, 30% casual, 20% moderate, 10% high
    let totalWatchTime = 0;
    const watchRoll = Math.random();
    if (watchRoll < 0.40) {
      totalWatchTime = 0;
    } else if (watchRoll < 0.70) {
      totalWatchTime = randomInt(45, 240); // 1 - 4 hrs
    } else if (watchRoll < 0.90) {
      totalWatchTime = randomInt(260, 900); // 4 - 15 hrs
    } else {
      totalWatchTime = randomInt(950, 2400); // 16 - 40 hrs
    }

    // Join date distributed over the last 180 days with higher density in recent months
    const dateProgress = Math.pow(Math.random(), 0.6); // Skews towards recent dates
    const createdAtTime = Math.floor(sixMonthsAgo + dateProgress * (now - sixMonthsAgo));
    const createdAt = new Date(createdAtTime);
    const lastLogin = new Date(Math.min(now, createdAtTime + randomInt(1, 30) * 24 * 60 * 60 * 1000));

    const deviceName = randomChoice(DEVICES);
    const deviceType = deviceName.includes('iPhone') ? 'mobile' : (deviceName.includes('Chrome') ? 'web' : 'mobile');

    const userDoc = {
      name,
      email,
      phone: `+91${phone}`,
      avatar: '',
      subscriptionPlan,
      subscriptionPlanName,
      subscriptionStatus: 'active',
      subscriptionExpiry,
      profiles: [
        {
          name,
          avatar: '',
          isKids: false,
          language: 'Hindi',
          maturityLevel: 18,
        },
      ],
      devices: [
        {
          deviceId: `dev_${phone.slice(-6)}_${randomInt(100, 999)}`,
          deviceType,
          deviceName,
          lastSeen: lastLogin,
        },
      ],
      preferredLanguage: randomChoice(['Hindi', 'Hindi', 'Hindi', 'English', 'Punjabi']),
      languageSelectionSkipped: false,
      preferredRegion: 'IN',
      watchlistCount: randomInt(0, 5),
      totalWatchTime,
      videoQuality: 'auto',
      status: 'active',
      loginCount: randomInt(1, 25),
      walletBalance: randomChoice([0, 0, 0, 10, 20, 50]),
      createdAt,
      updatedAt: lastLogin,
    };

    newUsers.push(userDoc);
  }

  console.log(`Inserting ${newUsers.length} users into the database...`);
  await db.collection('users').insertMany(newUsers);

  const finalTotal = await db.collection('users').countDocuments();
  console.log('\n=========================================');
  console.log(`  Target Total: ${TARGET_TOTAL}`);
  console.log(`  New Total Users in DB: ${finalTotal}`);
  console.log(`  Real Users Preserved: ${currentCount} (100% safe)`);
  console.log(`  Added Fake Users: ${newUsers.length}`);
  console.log('=========================================\n');

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
}

seedFakeUsers().catch((err) => {
  console.error('Error running seed script:', err);
  process.exit(1);
});
