/**
 * Merge a temp OTP account into an existing email account (keeps subscription).
 *
 *   npx tsx scripts/merge-temp-to-email.ts --phone 8306690426 --email jhajhariasourabh7@gmail.com
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureMongoDbName } from '../src/lib/mongodb';
import { UserModel } from '../src/models/User';
import { UserWishlistModel } from '../src/models/UserWishlist';
import { UserLikeModel } from '../src/models/UserLike';
import { UserDownloadModel } from '../src/models/UserDownload';
import { UserWatchProgressModel } from '../src/models/UserWatchProgress';

function flag(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? '' : String(process.argv[i + 1] || '').trim();
}

async function main() {
  const phone = flag('phone').replace(/\D/g, '').slice(-10);
  const email = flag('email').toLowerCase();
  if (!phone || !email) {
    console.log('Usage: npx tsx scripts/merge-temp-to-email.ts --phone 8306690426 --email you@gmail.com');
    process.exit(1);
  }

  await mongoose.connect(ensureMongoDbName(process.env.MONGODB_URI!));

  const real = await UserModel.findOne({ email });
  if (!real) {
    console.error('No user with email', email);
    process.exit(1);
  }

  const temp = await UserModel.findOne({
    $or: [{ phone }, { phone: `91${phone}` }, { phone: `+91${phone}` }],
    email: { $regex: /@temp\.local$/i },
  });

  console.log('Real account:', {
    id: String(real._id),
    email: real.email,
    phone: (real as any).phone,
    plan: (real as any).subscriptionPlan,
    status: (real as any).subscriptionStatus,
  });
  console.log('Temp account:', temp
    ? { id: String(temp._id), email: temp.email, phone: (temp as any).phone }
    : '(none)');

  (real as any).phone = phone;
  await real.save();

  if (temp && String(temp._id) !== String(real._id)) {
    await Promise.all([
      UserWishlistModel.updateMany({ userId: temp._id }, { $set: { userId: real._id } }),
      UserLikeModel.updateMany({ userId: temp._id }, { $set: { userId: real._id } }),
      UserDownloadModel.updateMany({ userId: temp._id }, { $set: { userId: real._id } }),
      UserWatchProgressModel.updateMany({ userId: temp._id }, { $set: { userId: real._id } }),
    ]);
    await UserModel.findByIdAndDelete(temp._id);
    console.log('✓ Merged temp → real and deleted temp');
  } else {
    console.log('✓ Phone set on real account (no temp to delete)');
  }

  // Clear duplicate phones
  await UserModel.updateMany(
    { _id: { $ne: real._id }, phone: { $in: [phone, `91${phone}`, `+91${phone}`] } },
    { $unset: { phone: 1 } }
  );

  const after = await UserModel.findById(real._id).lean();
  console.log('After:', {
    email: after?.email,
    phone: (after as any)?.phone,
    plan: (after as any)?.subscriptionPlan,
    status: (after as any)?.subscriptionStatus,
  });

  await mongoose.disconnect();
  console.log('\nDone. Log out on website, then Phone OTP login with', phone);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
