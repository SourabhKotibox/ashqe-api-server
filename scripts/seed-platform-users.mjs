import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose, { Types } from 'mongoose';

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

// 2. Comprehensive, authentic Indian names (Male, Female, Surnames)
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
  'Inder', 'Jagdish', 'Kamal', 'Lalit', 'Mukesh', 'Nirav', 'Praveen', 'Raman', 'Sandip', 'Tanmay',
  'Umesh', 'Vijay', 'Wasim', 'Yuvraj', 'Zeeshan', 'Abhay', 'Anand', 'Bhavesh', 'Chinmay', 'Dhruv',
  'Gautam', 'Hrithik', 'Imran', 'Jaideep', 'Kailash', 'Lokesh', 'Manav', 'Neeraj', 'Prateek', 'Ratan',
  'Satish', 'Trilok', 'Uday', 'Vipul', 'Yogesh', 'Aniruddh', 'Bikram', 'Chanchal', 'Deven', 'Farhan',
  'Gagan', 'Harish', 'Indrajit', 'Jitendra', 'Kuldeep', 'Madan', 'Nayan', 'Ojas', 'Prem', 'Ravindra',
  'Shailesh', 'Tanuj', 'Upendra', 'Vidyut', 'Yashwant', 'Adhiraj', 'Balram', 'Chhatrapal', 'Dhanush', 'Govind',
  'Hariom', 'Ishwar', 'Joginder', 'Kishan', 'Lokendra', 'Mridul', 'Narayan', 'Prabhat', 'Raghvendra', 'Satyendra',
  'Tribhuvan', 'Umang', 'Virendra', 'Akhil', 'Bipin', 'Chaitanya', 'Damodar', 'Eklavya', 'Gopal', 'Himanshu',
  'Jayesh', 'Kritik', 'Lalitmohan', 'Manpreet', 'Navneet', 'Pramod', 'Rajiv', 'Shashank', 'Tapan', 'Vasant',
  'Akshat', 'Badri', 'Chandrakant', 'Devendra', 'Fateh', 'Gurpreet', 'Harendra', 'Jagmohan', 'Kalyan', 'Mahipal',
  'Narendra', 'Pawan', 'Ramakant', 'Shivansh', 'Tejpal', 'Vedant', 'Amrish', 'Balvinder', 'Charanjit', 'Dilip',
  'Girishankar', 'Harvinder', 'Jaspreet', 'Kanwar', 'Manglesh', 'Nirmal', 'Pratap', 'Ranjit', 'Somesh', 'Upjit',
  'Anmol', 'Bhupendra', 'Chidambaram', 'Dharmendra', 'Gurmeet', 'Hardayal', 'Jaswant', 'Kaustubh', 'Manvendra', 'Nupur'
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
  'Chitrangada', 'Devika', 'Gauri', 'Harleen', 'Ira', 'Juhi', 'Kiran', 'Leena', 'Madhu', 'Naina',
  'Prachi', 'Richa', 'Sarita', 'Tejaswi', 'Uma', 'Varsha', 'Anuradha', 'Babita', 'Chandani', 'Damini',
  'Geetanjali', 'Harshita', 'Indu', 'Jasmin', 'Kalpana', 'Latika', 'Mridula', 'Navya', 'Poonam', 'Rashmi',
  'Sheetal', 'Tara', 'Upasana', 'Vasundhara', 'Archana', 'Bina', 'Chhaya', 'Deepa', 'Gayatri', 'Heena',
  'Ishani', 'Jayshree', 'Kalyani', 'Laxmi', 'Mamta', 'Neelam', 'Pratibha', 'Renu', 'Shalini', 'Taruna',
  'Usha', 'Vimla', 'Amrita', 'Bindu', 'Chitra', 'Durga', 'Gita', 'Hema', 'Ila', 'Jyotsna',
  'Kamini', 'Madhavi', 'Nisha', 'Pushpa', 'Rupal', 'Shobha', 'Tulsi', 'Vinita', 'Anamika', 'Bhagwati',
  'Chaman', 'Divyanshi', 'Gracy', 'Hiral', 'Inaya', 'Jivika', 'Kashish', 'Lipika', 'Manju', 'Nirupama',
  'Prerna', 'Reena', 'Suman', 'Tanushree', 'Ujwala', 'Vaishali', 'Aparna', 'Bhairavi', 'Chanchala', 'Dolly',
  'Gungun', 'Honey', 'Ipsita', 'Janki', 'Karishma', 'Lata', 'Mala', 'Nirmala', 'Priyanka', 'Rohini',
  'Sunita', 'Tripti', 'Urmila', 'Vandita', 'Aastha', 'Binita', 'Chanchal', 'Dipti', 'Garvita', 'Hardeep',
  'Indira', 'Jasleen', 'Kritika', 'Lopamudra', 'Malini', 'Nandita', 'Pratima', 'Roopam', 'Sunidhi', 'Twinkle',
  'Urvi', 'Vedika', 'Abha', 'Bhavika', 'Charulata', 'Devyani', 'Gitanjali', 'Harshada', 'Ishwarya', 'Jasmine'
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
  'Singhania', 'Goenka', 'Mittal', 'Lodha', 'Khandelwal', 'Maheshwari', 'Trivedi', 'Bhandari', 'Soni', 'Modi',
  'Bhatnagar', 'Dixit', 'Awasthi', 'Upadhyay', 'Chaubey', 'Pandita', 'Sood', 'Kapur', 'Trehan', 'Kohli',
  'Dhawan', 'Bhasin', 'Sahni', 'Nagpal', 'Talwar', 'Taneja', 'Madan', 'Batra', 'Gulati', 'Chhabra',
  'Pasricha', 'Sabharwal', 'Arora', 'Sachdeva', 'Virk', 'Sidhu', 'Sandhu', 'Dhillon', 'Grewal', 'Brar',
  'Cheema', 'Deol', 'Mann', 'Aulakh', 'Ghoshal', 'Ganguly', 'Chakraborty', 'Bhowmick', 'Majumdar', 'Barman',
  'Sanyal', 'Sen', 'Pal', 'Chanda', 'Dasgupta', 'Sarkar', 'Mitra', 'Basu', 'Kundu', 'Haldar',
  'Biswas', 'Mondal', 'Barua', 'Bora', 'Saikia', 'Goswami', 'Barman', 'Kakati', 'Kalita', 'Deka',
  'Hazarika', 'Gogoi', 'Sarma', 'Bezbaruah', 'Medhi', 'Bhattacharyya', 'Mohanty', 'Panda', 'Patnaik', 'Rath',
  'Behera', 'Pradhan', 'Tripathy', 'Samal', 'Sahoo', 'Panigrahi', 'Padhi', 'Lenka', 'Bhoi', 'Swain',
  'Hegde', 'Shetty', 'Kamath', 'Prabhu', 'Bhat', 'Shenoy', 'Pai', 'Nadkarni', 'Rao', 'Bhandary',
  'Iyer', 'Iyengar', 'Raman', 'Subramanian', 'Krishnan', 'Venkatesh', 'Balaji', 'Swaminathan', 'Natarajan', 'Sundaram',
  'Kannan', 'Murugan', 'Sridhar', 'Srinivasan', 'Raghavan', 'Parthasarathy', 'Gopalakrishnan', 'Ananthakrishnan', 'Narayanan', 'Chandrasekhar'
];

const DEVICES = [
  { name: 'Samsung Galaxy S23', type: 'mobile' },
  { name: 'Samsung Galaxy M34 5G', type: 'mobile' },
  { name: 'Samsung Galaxy A14 5G', type: 'mobile' },
  { name: 'Samsung Galaxy A54 5G', type: 'mobile' },
  { name: 'Redmi Note 12 Pro', type: 'mobile' },
  { name: 'Redmi 12 5G', type: 'mobile' },
  { name: 'Xiaomi 13 Pro', type: 'mobile' },
  { name: 'Realme 11 Pro+ 5G', type: 'mobile' },
  { name: 'Realme Narzo 60', type: 'mobile' },
  { name: 'Vivo V29 5G', type: 'mobile' },
  { name: 'Vivo Y200 5G', type: 'mobile' },
  { name: 'Vivo T2 Pro 5G', type: 'mobile' },
  { name: 'OnePlus Nord CE 3 Lite', type: 'mobile' },
  { name: 'OnePlus 11R 5G', type: 'mobile' },
  { name: 'OnePlus 12', type: 'mobile' },
  { name: 'iPhone 13', type: 'mobile' },
  { name: 'iPhone 14', type: 'mobile' },
  { name: 'iPhone 15', type: 'mobile' },
  { name: 'iPhone 15 Pro', type: 'mobile' },
  { name: 'Motorola G54 5G', type: 'mobile' },
  { name: 'Motorola Edge 40 Neo', type: 'mobile' },
  { name: 'Poco X5 Pro 5G', type: 'mobile' },
  { name: 'Poco M6 Pro 5G', type: 'mobile' },
  { name: 'Chrome on Windows 11', type: 'web' },
  { name: 'Chrome on macOS', type: 'web' },
  { name: 'Safari on iPhone', type: 'mobile' },
  { name: 'Android Smart TV', type: 'tv' },
  { name: 'Fire TV Stick 4K', type: 'tv' }
];

const EMAIL_DOMAINS = [
  'gmail.com', 'gmail.com', 'gmail.com', 'gmail.com', // 50%+ gmail
  'yahoo.com', 'yahoo.com',
  'outlook.com', 'outlook.com',
  'icloud.com',
  'hotmail.com'
];

const BIRTH_YEARS = [
  '85', '87', '88', '89', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99',
  '00', '01', '02', '03', '04', '05',
  '1988', '1990', '1992', '1994', '1995', '1996', '1998', '2000', '2001', '2002'
];

const LUCKY_NUMBERS = [
  '7', '07', '11', '21', '24', '44', '77', '88', '99', '100', '123', '321', '786', '999'
];

const MIDDLE_INITIALS = ['k', 'r', 's', 'm', 'p', 'a', 'v', 'd', 'b', 'n'];

const SUBSCRIPTION_TIERS = [
  {
    plan: 'free',
    name: 'Free Plan',
    id: null,
    weight: 0.40, // 40% free
    durationDays: 0
  },
  {
    plan: 'Silver',
    name: 'Silver',
    id: '6a69de15e3d8748009dd0f20',
    weight: 0.28, // 28% Silver
    durationDays: 30
  },
  {
    plan: 'Gold',
    name: 'Gold',
    id: '6a69de15e3d8748009dd0f21',
    weight: 0.20, // 20% Gold
    durationDays: 90
  },
  {
    plan: 'Platinum',
    name: 'Platinum',
    id: '6a69de15e3d8748009dd0f22',
    weight: 0.08, // 8% Platinum
    durationDays: 180
  },
  {
    plan: 'Star Platinum',
    name: 'Star Platinum',
    id: '6a69de15e3d8748009dd0f23',
    weight: 0.04, // 4% Star Platinum
    durationDays: 365
  }
];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickSubscriptionTier() {
  const r = Math.random();
  let cumulative = 0;
  for (const tier of SUBSCRIPTION_TIERS) {
    cumulative += tier.weight;
    if (r <= cumulative) return tier;
  }
  return SUBSCRIPTION_TIERS[0];
}

async function seedPlatformUsers() {
  const TARGET_TOTAL = 11031;
  const rawUri = getMongoUri();
  const uri = ensureAshqeDb(rawUri);

  console.log('Connecting to MongoDB Atlas...');
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 20000,
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
    return;
  }

  const needed = TARGET_TOTAL - currentCount;
  console.log(`Target total: ${TARGET_TOTAL}. Adding exactly ${needed} platform users.`);
  console.log('All existing users will remain 100% untouched!\n');

  // Load ALL existing emails from the database into a Set to guarantee 0 collisions
  console.log('Loading existing emails to prevent collisions...');
  const existingUsers = await db.collection('users').find({}, { projection: { email: 1 } }).toArray();
  const usedEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase().trim()));
  console.log(`Loaded ${usedEmails.size} existing emails into collision check set.`);

  const now = Date.now();
  const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
  const BATCH_SIZE = 1000;
  let totalInserted = 0;

  // We will generate in batches and insert
  let pendingCount = needed;
  let batchIndex = 1;

  while (pendingCount > 0) {
    const currentBatchSize = Math.min(pendingCount, BATCH_SIZE);
    const batchUsers = [];

    for (let i = 0; i < currentBatchSize; i++) {
      const isMale = Math.random() > 0.44;
      const firstName = isMale ? randomChoice(FIRST_NAMES_MALE) : randomChoice(FIRST_NAMES_FEMALE);
      const lastName = randomChoice(LAST_NAMES);
      const fullName = `${firstName} ${lastName}`;

      const fLower = firstName.toLowerCase().replace(/[^a-z]/g, '');
      const lLower = lastName.toLowerCase().replace(/[^a-z]/g, '');

      // Generate a realistic authentic email
      let email = '';
      let attempts = 0;

      while (!email && attempts < 100) {
        attempts++;
        const domain = randomChoice(EMAIL_DOMAINS);
        const year = randomChoice(BIRTH_YEARS);
        const luckyNum = randomChoice(LUCKY_NUMBERS);
        const midInitial = randomChoice(MIDDLE_INITIALS);

        const patterns = [
          `${fLower}.${lLower}@${domain}`,
          `${fLower}${lLower}@${domain}`,
          `${fLower}.${lLower}${year}@${domain}`,
          `${fLower}${lLower}${year}@${domain}`,
          `${fLower}.${lLower}${luckyNum}@${domain}`,
          `${fLower}${lLower}${luckyNum}@${domain}`,
          `${fLower}_${lLower}@${domain}`,
          `${fLower}_${lLower}${year}@${domain}`,
          `${fLower}.${midInitial}.${lLower}@${domain}`,
          `${fLower[0]}.${lLower}${year}@${domain}`,
          `${fLower[0]}${lLower}${year}@${domain}`,
          `${lLower}.${fLower}@${domain}`,
          `${lLower}.${fLower}${year}@${domain}`,
          `${fLower}.${lLower}.official@${domain}`,
          `${fLower}.${lLower}.work@${domain}`,
          `iam${fLower}${lLower}@${domain}`,
          `the${fLower}${lLower}@${domain}`,
          `${fLower}${lLower}${midInitial}@${domain}`,
          `${fLower}.${midInitial}${lLower}${year}@${domain}`
        ];

        for (const candidate of patterns) {
          const lowerCand = candidate.toLowerCase();
          if (!usedEmails.has(lowerCand)) {
            email = lowerCand;
            usedEmails.add(lowerCand);
            break;
          }
        }
      }

      // If extremely rare collision occurs across all patterns, generate a clean genuine variation
      if (!email) {
        const domain = randomChoice(EMAIL_DOMAINS);
        const extraNum = randomInt(100, 9999);
        email = `${fLower}.${lLower}.${extraNum}@${domain}`.toLowerCase();
        usedEmails.add(email);
      }

      // Subscription plan
      const subTier = pickSubscriptionTier();
      let subscriptionExpiry = null;
      if (subTier.plan !== 'free') {
        const remainingDays = randomInt(10, subTier.durationDays + 60);
        subscriptionExpiry = new Date(now + remainingDays * 24 * 60 * 60 * 1000);
      }

      // Realistic watch time in minutes
      let totalWatchTime = 0;
      const watchRoll = Math.random();
      if (watchRoll < 0.35) {
        totalWatchTime = 0;
      } else if (watchRoll < 0.65) {
        totalWatchTime = randomInt(40, 300); // 40m - 5h
      } else if (watchRoll < 0.88) {
        totalWatchTime = randomInt(320, 1200); // 5h - 20h
      } else {
        totalWatchTime = randomInt(1250, 3600); // 20h - 60h
      }

      // Created date distribution over past 12 months with recency weight
      const timeFactor = Math.pow(Math.random(), 0.7);
      const createdAtTime = Math.floor(oneYearAgo + timeFactor * (now - oneYearAgo));
      const createdAt = new Date(createdAtTime);
      const lastLogin = new Date(Math.min(now, createdAtTime + randomInt(1, 45) * 24 * 60 * 60 * 1000));

      const selectedDevice = randomChoice(DEVICES);
      const deviceHex = Math.random().toString(36).substring(2, 10);

      const userDoc = {
        name: fullName,
        email,
        phone: '',
        avatar: '',
        passwordHash: '$2b$10$ym8/1w8FYw4mYjG4n9pIge4h5H1fB8G3D3J2n1k0L9m8N7b6V5c4X',
        subscriptionPlan: subTier.plan,
        subscriptionPlanName: subTier.name,
        subscriptionPlanId: subTier.id ? new Types.ObjectId(subTier.id) : undefined,
        subscriptionStatus: 'active',
        subscriptionExpiry,
        profiles: [
          {
            name: fullName,
            avatar: '',
            isKids: false,
            language: randomChoice(['Hindi', 'Hindi', 'Hindi', 'English', 'Punjabi', 'Marathi']),
            maturityLevel: 18,
          },
        ],
        devices: [
          {
            deviceId: `dev_${fLower}_${deviceHex}`,
            deviceType: selectedDevice.type,
            deviceName: selectedDevice.name,
            lastSeen: lastLogin,
          },
        ],
        preferredLanguage: randomChoice(['Hindi', 'Hindi', 'Hindi', 'English', 'Punjabi', 'Marathi', 'Gujarati']),
        languageSelectionSkipped: false,
        preferredRegion: 'IN',
        watchlistCount: randomInt(0, 7),
        totalWatchTime,
        videoQuality: randomChoice(['auto', 'auto', 'auto', 'best', 'data_saver']),
        status: 'active',
        loginCount: randomInt(1, 35),
        walletBalance: randomChoice([0, 0, 0, 0, 10, 20, 50, 100]),
        createdAt,
        updatedAt: lastLogin,
      };

      batchUsers.push(userDoc);
    }

    console.log(`Inserting batch ${batchIndex} (${batchUsers.length} users)...`);
    await db.collection('users').insertMany(batchUsers, { ordered: true });
    totalInserted += batchUsers.length;
    pendingCount -= batchUsers.length;
    console.log(`Progress: ${totalInserted} / ${needed} users inserted.`);
    batchIndex++;
  }

  const finalTotal = await db.collection('users').countDocuments();
  console.log('\n=========================================');
  console.log(`  Target Total: ${TARGET_TOTAL}`);
  console.log(`  New Total Users in DB: ${finalTotal}`);
  console.log(`  Original Real Users Preserved: ${currentCount} (100% untouched)`);
  console.log(`  New Users Added: ${totalInserted}`);
  console.log('=========================================\n');

  // Verify sample of newly inserted users
  const recentSample = await db.collection('users').find({}).sort({ _id: -1 }).limit(10).toArray();
  console.log('Sample of newly seeded users:');
  recentSample.forEach((u, idx) => {
    console.log(`  ${idx + 1}. ${u.name} | ${u.email} | Plan: ${u.subscriptionPlan} (${u.subscriptionPlanName || 'None'}) | Device: ${u.devices?.[0]?.deviceName || 'N/A'}`);
  });

  await mongoose.disconnect();
  console.log('\nDisconnected from MongoDB successfully.');
}

seedPlatformUsers().catch((err) => {
  console.error('Error running seed script:', err);
  process.exit(1);
});
