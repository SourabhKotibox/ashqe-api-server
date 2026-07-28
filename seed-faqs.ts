/**
 * seed-faqs.ts — Upsert Tataiya FAQs (18+ movies theme).
 *
 * Usage:
 *   npx tsx seed-faqs.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI!;

const FAQS = [
  {
    question: 'Is Tataiya only for adults (18+)?',
    answer:
      'Yes. Tataiya is an adults-only movie platform. You must be 18 years or older to create an account and stream. There is no kids mode or under-18 catalogue.',
    order: 1,
  },
  {
    question: 'What kind of movies are on Tataiya?',
    answer:
      'We focus on 18+ movies across genres such as drama, thriller, romance, horror, and other mature titles. Individual titles may show an 18+ age rating.',
    order: 2,
  },
  {
    question: 'How do I subscribe to a plan?',
    answer:
      'Sign in, open Plans / Subscription, choose the available plan (for example Standard), and complete payment. Access unlocks after a successful charge.',
    order: 3,
  },
  {
    question: 'Can I cancel anytime?',
    answer:
      'Yes. Cancel from Account Settings → Subscription. You keep access until the end of the current billing period. See the Refund Policy for refund rules.',
    order: 4,
  },
  {
    question: 'Can I download movies for offline viewing?',
    answer:
      'Where your plan and the title allow downloads, use the download option for personal offline viewing only. Do not redistribute downloaded files.',
    order: 5,
  },
  {
    question: 'What devices are supported?',
    answer:
      'You can stream on modern browsers on phones, tablets, and desktops. A stable internet connection is recommended for HD playback.',
    order: 6,
  },
  {
    question: 'Why am I asked to confirm I am 18+?',
    answer:
      'Because our catalogue contains mature content. Confirming your age is required before using Tataiya. Sharing your account with minors is prohibited.',
    order: 7,
  },
  {
    question: 'How do I reset my password?',
    answer:
      'On the login page choose Forgot Password, enter your email, and follow the reset link we send you.',
    order: 8,
  },
  {
    question: 'Video keeps buffering — what should I do?',
    answer:
      'Check your connection, lower player quality, close other apps or tabs, and try again. If the issue continues, email support@tataiya.in.',
    order: 9,
  },
  {
    question: 'How do I contact support?',
    answer:
      'Email support@tataiya.in. For underage access concerns use safety@tataiya.in. Billing questions: billing@tataiya.in.',
    order: 10,
  },
];

async function main() {
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log('db:', db.databaseName);

  // Replace FAQ set with Tataiya 18+ copy
  await db.collection('faqs').deleteMany({});
  const docs = FAQS.map((f) => ({
    question: f.question,
    answer: f.answer,
    status: true,
    order: f.order,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  await db.collection('faqs').insertMany(docs);

  console.log(`Seeded ${docs.length} FAQs`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
