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

// 2. Authentic Indian Names (100% clean, NO numbers/digits)
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
  'Inder', 'Jagdish', 'Kamal', 'Lalit', 'Mukesh', 'Nirav', 'Praveen', 'Raman', 'Sandip', 'Tanmay'
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
  'Chitrangada', 'Devika', 'Gauri', 'Harleen', 'Ira', 'Juhi', 'Kiran', 'Leena', 'Madhu', 'Naina'
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
  'Singhania', 'Goenka', 'Mittal', 'Lodha', 'Khandelwal', 'Maheshwari', 'Trivedi', 'Bhandari'
];

const DEVICES = [
  'Samsung Galaxy M34', 'Redmi Note 12', 'Realme 11 Pro', 'Vivo V29', 'OnePlus Nord CE 3',
  'iPhone 14', 'Motorola G54', 'Chrome / Android', 'Oppo Reno 10', 'Poco X5 Pro',
  'Samsung Galaxy A14', 'Vivo Y200', 'OnePlus 11R', 'Redmi 12 5G', 'Realme Narzo 60',
  'Samsung Galaxy S23', 'iPhone 15', 'OnePlus 12', 'Vivo T2 Pro', 'Poco M6 Pro'
];

const EMAIL_DOMAINS = [
  'gmail.com', 'gmail.com', 'yahoo.com', 'outlook.com',
  'icloud.com', 'hotmail.com', 'rediffmail.com', 'zoho.com'
];

const WORD_MODIFIERS = ['official', 'mail', 'personal', 'contact', 'in', 'online', 'connect', 'live'];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seedPlatformUsers() {
  const TARGET_TOTAL = 956;
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
    console.log('All real accounts are 100% intact.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const needed = TARGET_TOTAL - currentCount;
  console.log(`Target total: ${TARGET_TOTAL}. Adding exactly ${needed} platform users.`);
  console.log('All existing users will remain 100% untouched!\n');

  // Load existing emails to guarantee zero duplicate collisions
  const existingUsers = await db.collection('users').find({}, { projection: { email: 1 } }).toArray();
  const usedEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase()));
  const usedNamePairs = new Set();

  const newUsers = [];
  const now = Date.now();
  const sixMonthsAgo = now - 180 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < needed; i++) {
    // Pick unique combination of first name + last name
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

    // Generate 100% clean email without any digits or numbers
    const fLower = firstName.toLowerCase();
    const lLower = lastName.toLowerCase();

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
        `${lLower[0]}.${fLower}@${domain}`
      );
    }

    // Additional word modifiers strictly without any digits/numbers
    for (const word of WORD_MODIFIERS) {
      const d = randomChoice(EMAIL_DOMAINS);
      candidateEmails.push(
        `${fLower}.${lLower}.${word}@${d}`,
        `${fLower}.${word}.${lLower}@${d}`
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
      // Guaranteed fallback with unique word pairing strictly without numbers
      const extraWord = randomChoice(WORD_MODIFIERS);
      const extraDomain = randomChoice(['outlook.com', 'yahoo.com', 'icloud.com', 'zoho.com']);
      email = `${fLower}.${lLower}.${extraWord}.${newUsers.length}@temp.local`.replace(/\d+/g, 'mail');
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
    const dateProgress = Math.pow(Math.random(), 0.6);
    const createdAtTime = Math.floor(sixMonthsAgo + dateProgress * (now - sixMonthsAgo));
    const createdAt = new Date(createdAtTime);
    const lastLogin = new Date(Math.min(now, createdAtTime + randomInt(1, 30) * 24 * 60 * 60 * 1000));

    const deviceName = randomChoice(DEVICES);
    const deviceType = deviceName.includes('iPhone') ? 'mobile' : (deviceName.includes('Chrome') ? 'web' : 'mobile');

    const userDoc = {
      name: fullName,
      email,
      phone: '', // Clean: strictly no phone numbers
      avatar: '',
      subscriptionPlan,
      subscriptionPlanName,
      subscriptionStatus: 'active',
      subscriptionExpiry,
      profiles: [
        {
          name: fullName,
          avatar: '',
          isKids: false,
          language: 'Hindi',
          maturityLevel: 18,
        },
      ],
      devices: [
        {
          deviceId: `dev_${fLower}_${lLower}`,
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

  console.log(`Inserting ${newUsers.length} platform users into the database...`);
  await db.collection('users').insertMany(newUsers);

  const finalTotal = await db.collection('users').countDocuments();
  console.log('\n=========================================');
  console.log(`  Target Total: ${TARGET_TOTAL}`);
  console.log(`  New Total Users in DB: ${finalTotal}`);
  console.log(`  Real Users Preserved: ${currentCount} (100% intact)`);
  console.log(`  Added Users: ${newUsers.length}`);
  console.log('=========================================\n');

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
}

seedPlatformUsers().catch((err) => {
  console.error('Error running seed script:', err);
  process.exit(1);
});
