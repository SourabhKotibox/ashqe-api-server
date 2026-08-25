import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ensureMongoDbName } from './src/lib/mongodb';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@ashqe.app';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ashqe@Admin2026';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Ashqe Super Admin';

async function createAdmin() {
  const rawUri = process.env.MONGODB_URI;
  if (!rawUri) {
    throw new Error('MONGODB_URI is not set');
  }

  const uri = ensureMongoDbName(rawUri);
  await mongoose.connect(uri);
  console.log('Connected to DB:', mongoose.connection.name);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const db = mongoose.connection.db;
  if (!db) throw new Error('DB not connected');

  await db.collection('adminusers').updateOne(
    { email: ADMIN_EMAIL.toLowerCase() },
    {
      $set: {
        email: ADMIN_EMAIL.toLowerCase(),
        name: ADMIN_NAME,
        passwordHash,
        role: 'superadmin',
        isActive: true,
        updatedAt: new Date(),
        modulePermissions: {
          movies: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          tvShows: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          genres: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          actors: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          directors: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          languages: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          categories: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          mediaLibrary: { canView: true, canUpload: true, canDelete: true },
          banners: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          promotions: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          influencers: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          ads: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          pages: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          faqs: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          subscriptions: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          subscriptionPlans: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          planLimits: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          notifications: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          notificationTemplates: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          settings: { canView: true, canCreate: true, canEdit: true, canDelete: true },
          reviews: { canView: true, canCreate: true, canEdit: true, canDelete: true },
        },
      },
      $setOnInsert: { createdAt: new Date(), loginCount: 0 },
    },
    { upsert: true }
  );

  await db.collection('settings').updateOne(
    {},
    {
      $set: {
        platformName: 'Ashqe',
        logoUrl: '/logo.png',
        darkLogoUrl: '/logo.png',
        lightLogoUrl: '/logo.png',
        faviconUrl: '/favicon.png',
        primaryColor: '#e50914',
        colorTheme: 'blue-green',
        copyrightText: '© 2026 Ashqe. All Rights Reserved.',
        siteDescription: 'Ashqe — stream premium movies and series.',
        loginTitle: 'Welcome Back',
        loginSubtitle: 'Ashqe Admin Console',
        loginButtonText: 'Sign In',
        mailFrom: 'info@ashqe.app',
        mailFromName: 'Ashqe',
        metaTitle: 'Ashqe',
        metaDescription: 'Ashqe streaming platform',
        canonicalUrl: 'https://ashqe.app',
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  console.log('Ashqe admin ready');
  console.log('Email:', ADMIN_EMAIL.toLowerCase());
  console.log('Password:', ADMIN_PASSWORD);
  console.log('Admin login path: /admin/login');
  await mongoose.disconnect();
  process.exit(0);
}

createAdmin().catch((e) => {
  console.error(e);
  process.exit(1);
});
