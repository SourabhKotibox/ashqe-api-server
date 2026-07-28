import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/triple-mindes';

async function createAdmin() {
  await mongoose.connect(uri);
  const email = 'admin@tataiya.com';
  const password = 'Tataiya@Admin2026';
  const passwordHash = await bcrypt.hash(password, 12);

  const db = mongoose.connection.db;
  if (!db) throw new Error('DB not connected');

  await db.collection('adminusers').updateOne(
    { role: 'superadmin' },
    {
      $set: {
        email,
        name: 'Tataiya Super Admin',
        passwordHash,
        role: 'superadmin',
        isActive: true,
        updatedAt: new Date(),
        modulePermissions: {
          movies: { canView: true, canCreate: true, canEdit: true, canDelete: true },
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

  // Brand settings
  await db.collection('settings').updateOne(
    {},
    {
      $set: {
        platformName: 'Tataiya',
        logoUrl: '/logo.png',
        darkLogoUrl: '/logo.png',
        lightLogoUrl: '/logo.png',
        primaryColor: '#FFB800',
        copyrightText: '© 2026 Tataiya. All Rights Reserved.',
        siteDescription: 'Stream premium movies on Tataiya — honey-sweet entertainment.',
        loginTitle: 'Welcome Back',
        loginSubtitle: 'Tataiya Admin Console',
        loginButtonText: 'Sign In',
        storageDriver: 's3',
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  console.log('Admin ready');
  console.log('Email:', email);
  console.log('Password:', password);
  console.log('Admin login path: /admin/login');
  process.exit(0);
}

createAdmin().catch((e) => {
  console.error(e);
  process.exit(1);
});
