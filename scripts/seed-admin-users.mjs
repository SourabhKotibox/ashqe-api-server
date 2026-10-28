/**
 * Seed script — brings total AdminUser count up to TARGET_TOTAL (1413).
 * All existing admin accounts are 100% preserved.
 * Run: node scripts/seed-admin-users.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 1. Resolve MongoDB URI ───────────────────────────────────────────────────
function getMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const envPaths = [
    path.join(__dirname, '../.env'),
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), 'ashqe-api-server/.env'),
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

  // Fallback to the same connection used in seed-platform-users.mjs
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

// ─── 2. Name pools (Indian names, no digits) ─────────────────────────────────
const FIRST_NAMES_MALE = [
  'Aarav', 'Vihaan', 'Vivaan', 'Advik', 'Kabir', 'Rahul', 'Amit', 'Rohan', 'Karan', 'Vikram',
  'Sameer', 'Aditya', 'Arjun', 'Varun', 'Nikhil', 'Siddharth', 'Kunal', 'Gaurav', 'Manish',
  'Harshit', 'Raj', 'Abhishek', 'Ayush', 'Mohit', 'Deepak', 'Akash', 'Rohit', 'Suraj',
  'Yash', 'Pankaj', 'Sachin', 'Ankit', 'Vivek', 'Suresh', 'Manoj', 'Dinesh', 'Ajay', 'Vishal',
  'Naveen', 'Rakesh', 'Sanjay', 'Sunil', 'Pradeep', 'Ashok', 'Mahesh', 'Rajesh', 'Vinod', 'Anil',
  'Alok', 'Bharat', 'Chetan', 'Dev', 'Harsh', 'Hemant', 'Ishan', 'Jatin', 'Keshav', 'Mayank',
  'Nitin', 'Parth', 'Piyush', 'Pranav', 'Raghav', 'Rishabh', 'Saurabh', 'Shivam', 'Shubham', 'Tarun',
  'Tushar', 'Utkarsh', 'Vaibhav', 'Vikas', 'Aman', 'Anshul', 'Bhuvan', 'Chirag', 'Darshan', 'Eshan',
  'Hardik', 'Jayant', 'Kartik', 'Lakshya', 'Madhav', 'Nakul', 'Omkar', 'Pulkit', 'Ranveer', 'Samarth',
  'Tejas', 'Udit', 'Vansh', 'Yatharth', 'Armaan', 'Brijesh', 'Chandresh', 'Devansh', 'Girish', 'Hitesh',
];

const FIRST_NAMES_FEMALE = [
  'Ananya', 'Diya', 'Anaya', 'Aarohi', 'Priya', 'Neha', 'Sneha', 'Pooja', 'Riya', 'Simran',
  'Shreya', 'Megha', 'Kriti', 'Tanvi', 'Ishita', 'Divya', 'Sanya', 'Pallavi', 'Swati',
  'Sonali', 'Rashi', 'Preeti', 'Natasha', 'Shruti', 'Kavita', 'Ritu', 'Anjali', 'Komal',
  'Jyoti', 'Shikha', 'Bhavna', 'Meera', 'Nandini', 'Payal', 'Sakshi', 'Monika', 'Deepika', 'Aarti',
  'Aditi', 'Akanksha', 'Barkha', 'Chhavi', 'Disha', 'Garima', 'Gunjan', 'Himani', 'Isha', 'Jaya',
  'Kajal', 'Khushi', 'Lavanya', 'Mahima', 'Muskan', 'Nidhi', 'Parul', 'Radhika', 'Saloni', 'Shilpa',
  'Tanya', 'Urvashi', 'Vidhi', 'Yamini', 'Aashna', 'Charu', 'Drishti', 'Esha', 'Hansika', 'Jhanvi',
  'Kangan', 'Mansi', 'Nupur', 'Palak', 'Reema', 'Saumya', 'Trisha', 'Vandana', 'Alisha', 'Bhumika',
];

const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Patel', 'Singh', 'Kumar', 'Das', 'Joshi', 'Yadav', 'Mishra',
  'Chauhan', 'Jain', 'Bhatia', 'Agarwal', 'Malhotra', 'Kapoor', 'Saxena', 'Tiwari', 'Pandey', 'Mehta',
  'Shah', 'Reddy', 'Nair', 'Rao', 'Choudhary', 'Sengupta', 'Banerjee', 'Gill', 'Sethi', 'Dubey',
  'Bhardwaj', 'Shukla', 'Tripathi', 'Thakur', 'Goyal', 'Bansal', 'Garg', 'Chopra', 'Dewan', 'Bose',
  'Kashyap', 'Mathur', 'Kaushik', 'Kulshrestha', 'Bhattacharya', 'Mukherjee', 'Chatterjee', 'Dutta',
  'Ghosh', 'Roy', 'Mahajan', 'Khanna', 'Grover', 'Puri', 'Bedi', 'Chawla', 'Juneja', 'Ahuja',
  'Wadhwa', 'Narang', 'Bajaj', 'Vohra', 'Bakshi', 'Anand', 'Nayak', 'Pillai', 'Menon', 'Nambiar',
  'Deshmukh', 'Kulkarni', 'Patil', 'Shinde', 'Gaikwad', 'More', 'Sawant', 'Bhosle', 'Rathore', 'Somani',
];

const EMAIL_DOMAINS = [
  'gmail.com', 'gmail.com', 'yahoo.com', 'outlook.com',
  'icloud.com', 'hotmail.com', 'rediffmail.com', 'zoho.com',
];

const WORD_MODIFIERS = ['admin', 'official', 'work', 'contact', 'in', 'online', 'connect', 'live'];

// Role distribution: 70% admin, 20% moderator, 10% influencer
const ROLES = ['admin', 'admin', 'admin', 'admin', 'admin', 'admin', 'admin', 'moderator', 'moderator', 'influencer'];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const defaultModulePermissions = {
  movies: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  tvShows: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  genres: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  actors: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  directors: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  languages: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  categories: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  mediaLibrary: { canView: true, canUpload: false, canDelete: false },
  banners: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  promotions: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  influencers: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  ads: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  pages: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  faqs: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  subscriptions: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  subscriptionPlans: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  planLimits: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  notifications: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  notificationTemplates: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  settings: { canView: true, canCreate: false, canEdit: false, canDelete: false },
  reviews: { canView: true, canCreate: false, canEdit: false, canDelete: false },
};

async function seedAdminUsers() {
  const TARGET_TOTAL = 1413;

  const rawUri = getMongoUri();
  const uri = ensureAshqeDb(rawUri);

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to database: "${mongoose.connection.name}"`);

  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection failed');

  const currentCount = await db.collection('adminusers').countDocuments();
  console.log(`Current existing admin users in database: ${currentCount}`);

  if (currentCount >= TARGET_TOTAL) {
    console.log(`Database already has ${currentCount} admin users (target is ${TARGET_TOTAL}).`);
    console.log('All real admin accounts are 100% intact.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const needed = TARGET_TOTAL - currentCount;
  console.log(`Target total: ${TARGET_TOTAL}. Adding exactly ${needed} admin users.`);
  console.log('All existing admin users will remain 100% untouched!\n');

  // Load existing emails to guarantee zero duplicate collisions
  const existingAdmins = await db.collection('adminusers').find({}, { projection: { email: 1 } }).toArray();
  const usedEmails = new Set(existingAdmins.map(u => (u.email || '').toLowerCase()));
  const usedNamePairs = new Set();

  // Pre-hash a common password for all seeded admins (fast, single hash)
  const sharedPassword = 'Ashqe@Admin2026';
  console.log('Hashing shared password...');
  const passwordHash = await bcrypt.hash(sharedPassword, 10);

  const newAdmins = [];
  const now = Date.now();
  const sixMonthsAgo = now - 180 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < needed; i++) {
    // Pick unique first + last name combination
    let firstName = '';
    let lastName = '';
    let fullName = '';
    let attempts = 0;

    while (attempts < 2000) {
      const isMale = Math.random() > 0.45;
      firstName = isMale ? randomChoice(FIRST_NAMES_MALE) : randomChoice(FIRST_NAMES_FEMALE);
      lastName = randomChoice(LAST_NAMES);
      fullName = `${firstName} ${lastName}`;
      if (!usedNamePairs.has(fullName)) {
        usedNamePairs.add(fullName);
        break;
      }
      attempts++;
    }

    const fLower = firstName.toLowerCase();
    const lLower = lastName.toLowerCase();

    // Generate unique email (no digits)
    const candidateEmails = [];
    for (const domain of EMAIL_DOMAINS) {
      candidateEmails.push(
        `${fLower}.${lLower}@${domain}`,
        `${fLower}_${lLower}@${domain}`,
        `${fLower}${lLower}@${domain}`,
        `${lLower}.${fLower}@${domain}`,
        `${lLower}_${fLower}@${domain}`,
        `${fLower[0]}.${lLower}@${domain}`,
        `${fLower}.${lLower[0]}@${domain}`,
        `${fLower[0]}_${lLower}@${domain}`,
        `${fLower[0]}${lLower}@${domain}`,
        `${lLower[0]}.${fLower}@${domain}`,
      );
    }
    for (const word of WORD_MODIFIERS) {
      const d = randomChoice(EMAIL_DOMAINS);
      candidateEmails.push(
        `${fLower}.${lLower}.${word}@${d}`,
        `${fLower}.${word}.${lLower}@${d}`,
      );
    }

    let email = '';
    for (const candidate of candidateEmails) {
      if (!usedEmails.has(candidate.toLowerCase())) {
        email = candidate.toLowerCase();
        usedEmails.add(email);
        break;
      }
    }

    if (!email) {
      // Fallback — guaranteed unique using position index (no real digits shown)
      const extraWord = randomChoice(WORD_MODIFIERS);
      email = `${fLower}.${lLower}.${extraWord}.x${newAdmins.length}@admin.local`;
      usedEmails.add(email);
    }

    // Join date distributed over the last 180 days
    const dateProgress = Math.pow(Math.random(), 0.6);
    const createdAtTime = Math.floor(sixMonthsAgo + dateProgress * (now - sixMonthsAgo));
    const createdAt = new Date(createdAtTime);
    const lastLogin = new Date(
      Math.min(now, createdAtTime + randomInt(0, 45) * 24 * 60 * 60 * 1000)
    );

    const role = randomChoice(ROLES);

    const adminDoc = {
      email,
      name: fullName,
      passwordHash,
      role,
      avatar: '',
      phone: '',
      modulePermissions: defaultModulePermissions,
      isActive: Math.random() > 0.05, // 95% active
      lastLogin,
      loginCount: randomInt(1, 50),
      walletBalance: 0,
      createdAt,
      updatedAt: lastLogin,
    };

    newAdmins.push(adminDoc);

    if ((i + 1) % 200 === 0) {
      process.stdout.write(`  ... prepared ${i + 1} / ${needed}\n`);
    }
  }

  console.log(`\nInserting ${newAdmins.length} admin users into the database...`);
  await db.collection('adminusers').insertMany(newAdmins);

  const finalTotal = await db.collection('adminusers').countDocuments();
  console.log('\n=========================================');
  console.log(`  Target Total:           ${TARGET_TOTAL}`);
  console.log(`  New Total Admin Users:  ${finalTotal}`);
  console.log(`  Real Admins Preserved:  ${currentCount} (100% intact)`);
  console.log(`  Seeded Admins Added:    ${newAdmins.length}`);
  console.log('=========================================\n');

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
}

seedAdminUsers().catch((err) => {
  console.error('Error running admin seed script:', err);
  process.exit(1);
});
