/**
 * seed-ads.ts — Seeds Tataiya demo ads for Home Page + Player placements.
 * Run: npx tsx src/seed-ads.ts
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { AdModel } from './models/Ad';

dotenv.config();

const YEAR = 365 * 24 * 60 * 60 * 1000;

const TEST_ADS = [
  {
    adName: '[Tataiya] Home Banner — Premium Movies',
    adType: 'Image' as const,
    urlType: 'URL' as const,
    mediaUrl: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=1400&h=320&fit=crop&auto=format',
    placement: 'Home Page',
    redirectUrl: '/membership',
    targetContentType: 'Movie',
    status: 'active' as const,
    startDate: new Date(),
    endDate: new Date(Date.now() + YEAR),
    impressions: 12,
    clicks: 2,
  },
  {
    adName: '[Tataiya] Home Banner — HTML Promo',
    adType: 'Custom' as const,
    urlType: 'URL' as const,
    mediaUrl: `
      <div style="background:linear-gradient(135deg,#FFB800 0%,#B45309 55%,#0c0c14 100%);padding:24px 28px;border-radius:16px;display:flex;align-items:center;justify-content:space-between;gap:20px;font-family:system-ui,sans-serif;min-height:110px;">
        <div style="flex:1;min-width:0;">
          <div style="display:inline-block;background:rgba(0,0,0,0.25);color:#fff;font-size:10px;font-weight:800;padding:3px 8px;border-radius:4px;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Sponsored</div>
          <h3 style="color:#111;font-size:clamp(16px,3vw,22px);font-weight:900;margin:0 0 6px 0;">Stream more on Tataiya</h3>
          <p style="color:rgba(0,0,0,0.75);font-size:13px;margin:0 0 14px 0;line-height:1.45;">Movies in HD &amp; 4K. Plans starting free. Upgrade anytime.</p>
          <a href="/membership" style="display:inline-block;background:#111;color:#FFB800;font-size:13px;font-weight:800;padding:10px 20px;border-radius:8px;text-decoration:none;">View plans →</a>
        </div>
      </div>
    `,
    placement: 'Home Page',
    redirectUrl: '/membership',
    targetContentType: 'All',
    status: 'active' as const,
    startDate: new Date(),
    endDate: new Date(Date.now() + YEAR),
    impressions: 8,
    clicks: 1,
  },
  {
    adName: '[Tataiya] Player Pre-roll — Image',
    adType: 'Image' as const,
    urlType: 'URL' as const,
    mediaUrl: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=1920&h=1080&fit=crop&auto=format',
    placement: 'Player',
    redirectUrl: '/membership',
    targetContentType: 'All',
    status: 'active' as const,
    startDate: new Date(),
    endDate: new Date(Date.now() + YEAR),
    impressions: 20,
    clicks: 3,
  },
  {
    adName: '[Tataiya] Player Pre-roll — HTML',
    adType: 'Custom' as const,
    urlType: 'URL' as const,
    mediaUrl: `
      <div style="width:100%;height:100%;min-height:220px;background:linear-gradient(135deg,#0f0f1a 0%,#1a1408 50%,#16213e 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:system-ui,sans-serif;padding:24px;box-sizing:border-box;">
        <div style="text-align:center;max-width:520px;">
          <div style="display:inline-block;background:rgba(255,184,0,0.15);border:1px solid rgba(255,184,0,0.35);color:#FFB800;font-size:11px;font-weight:800;padding:4px 14px;border-radius:20px;letter-spacing:1px;text-transform:uppercase;margin-bottom:16px;">Advertisement</div>
          <h2 style="color:#fff;font-size:clamp(18px,4vw,32px);font-weight:900;margin:0 0 10px 0;">Go Premium on Tataiya</h2>
          <p style="color:rgba(255,255,255,0.7);font-size:clamp(12px,2vw,15px);line-height:1.55;margin:0 auto 20px auto;">Ad-free playback, downloads, and higher resolution on Standard &amp; Premium plans.</p>
          <a href="/membership" style="display:inline-block;background:linear-gradient(135deg,#FFB800,#B45309);color:#111;font-size:14px;font-weight:800;padding:12px 28px;border-radius:12px;text-decoration:none;">Upgrade now →</a>
        </div>
      </div>
    `,
    placement: 'Player',
    redirectUrl: '/membership',
    targetContentType: 'All',
    status: 'active' as const,
    startDate: new Date(),
    endDate: new Date(Date.now() + YEAR),
    impressions: 15,
    clicks: 2,
  },
];

async function seedAds() {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error('MONGODB_URI not set');
      process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('Connected to MongoDB');

    await AdModel.deleteMany({
      $or: [
        { adName: /^🧪 \[TEST\]/ },
        { adName: /^\[Tataiya\]/ },
      ],
    });

    for (const adData of TEST_ADS) {
      await AdModel.create(adData);
      console.log(`Created: ${adData.adName} (${adData.placement})`);
    }

    const total = await AdModel.countDocuments({ status: 'active' });
    console.log(`Done. Active ads: ${total}`);
    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  }
}

seedAds();
