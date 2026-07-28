/**
 * seed-pages.ts — Upsert Tataiya CMS pages (18+ movies theme).
 *
 * Usage:
 *   npx tsx seed-pages.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI!;

type PageSeed = {
  title: string;
  slug: string;
  order: number;
  metaTitle: string;
  metaDescription: string;
  content: string;
};

const PAGES: PageSeed[] = [
  {
    title: 'Privacy Policy',
    slug: 'privacy-policy',
    order: 1,
    metaTitle: 'Privacy Policy | Tataiya',
    metaDescription: 'How Tataiya collects, uses, and protects your personal data on our 18+ movie streaming platform.',
    content: `<h1>Privacy Policy</h1>
<p>Last updated: July 2026</p>
<p>Tataiya ("we", "us", "our") operates an adult-oriented (18+) movie streaming service at <strong>tataiya.in</strong>. This Privacy Policy explains what information we collect, how we use it, and your choices.</p>

<h2>1. Who Can Use Tataiya</h2>
<p>Tataiya is intended <strong>only for adults aged 18 years and above</strong>. We do not knowingly collect personal data from anyone under 18. If we learn that a minor has created an account, we will delete it and related data.</p>

<h2>2. Information We Collect</h2>
<ul>
  <li><strong>Account data:</strong> name, email, phone (if provided), password (hashed), and profile preferences.</li>
  <li><strong>Billing data:</strong> subscription plan, payment status, and limited transaction references from our payment partners (we do not store full card numbers).</li>
  <li><strong>Usage data:</strong> titles watched, watch progress, searches, likes, wishlist, downloads, and device/session info.</li>
  <li><strong>Technical data:</strong> IP address, browser/app type, device identifiers, approximate location derived from IP, and crash/performance logs.</li>
  <li><strong>Communications:</strong> support messages and feedback you send us.</li>
</ul>

<h2>3. How We Use Your Information</h2>
<ul>
  <li>Provide and improve streaming, recommendations, and account features</li>
  <li>Process subscriptions, renewals, and billing support</li>
  <li>Enforce our <strong>18+ age requirement</strong> and prevent underage access where reasonably possible</li>
  <li>Send service emails (receipts, security alerts); marketing only with your consent where required</li>
  <li>Detect fraud, abuse, piracy, and unauthorized sharing of accounts</li>
  <li>Comply with applicable laws and respond to lawful requests</li>
</ul>

<h2>4. Mature Content &amp; Sensitive Preferences</h2>
<p>Because Tataiya hosts <strong>18+ / mature movies</strong>, viewing history and preferences may reflect adult themes. We treat this as sensitive usage data and do not sell it. We use it only to operate the service, personalize recommendations, and improve content discovery for adult users.</p>

<h2>5. Sharing of Information</h2>
<p>We do not sell your personal information. We may share limited data with:</p>
<ul>
  <li>Payment processors and subscription billing partners</li>
  <li>Cloud hosting, CDN, email, and analytics providers under contract</li>
  <li>Authorities when required by law or to protect users and the platform</li>
</ul>

<h2>6. Cookies &amp; Similar Technologies</h2>
<p>We use cookies and similar technologies for login sessions, preferences, analytics, and (where enabled) advertising measurement. See our <a href="/page/cookie-policy">Cookie Policy</a> for details.</p>

<h2>7. Data Retention &amp; Security</h2>
<p>We retain account and usage data while your account is active and for a reasonable period afterward for legal, security, and accounting purposes. We use industry-standard safeguards (encryption in transit, access controls). No method of transmission or storage is 100% secure.</p>

<h2>8. Your Rights</h2>
<p>Subject to applicable Indian law, you may request access, correction, or deletion of your personal data, or close your account. Contact <strong>privacy@tataiya.in</strong>. We may need to verify your identity before fulfilling requests.</p>

<h2>9. International Processing</h2>
<p>Your data may be processed on servers in India or other regions used by our infrastructure providers, with appropriate safeguards.</p>

<h2>10. Changes</h2>
<p>We may update this policy from time to time. The "Last updated" date will change when we do. Continued use of Tataiya after changes means you accept the updated policy.</p>

<h2>Contact</h2>
<p>Privacy questions: <strong>privacy@tataiya.in</strong><br/>Support: <strong>support@tataiya.in</strong><br/>Website: <strong>https://tataiya.in</strong></p>`,
  },
  {
    title: 'Terms and Conditions',
    slug: 'terms-and-conditions',
    order: 2,
    metaTitle: 'Terms and Conditions | Tataiya',
    metaDescription: 'Terms of use for Tataiya — an 18+ adult movie streaming platform.',
    content: `<h1>Terms and Conditions</h1>
<p>Last updated: July 2026</p>
<p>These Terms govern your use of Tataiya, an <strong>adults-only (18+)</strong> movie streaming service. By creating an account or using the service, you agree to these Terms and our Privacy Policy.</p>

<h2>1. Eligibility (18+ Only)</h2>
<p>You must be at least <strong>18 years old</strong> to create an account or watch content on Tataiya. By using the service you represent that you are 18 or older and that accessing mature content is legal in your jurisdiction. Accounts for minors are prohibited and will be terminated.</p>

<h2>2. Mature Content</h2>
<p>Tataiya specializes in <strong>18+ movies</strong> that may include strong language, violence, sexual content, nudity, or other adult themes. Content is provided for entertainment to consenting adults. You are solely responsible for ensuring that viewing such material is appropriate and lawful for you.</p>

<h2>3. Accounts</h2>
<ul>
  <li>Keep your login credentials confidential. You are responsible for activity under your account.</li>
  <li>Do not share, sell, or rent your account.</li>
  <li>Notify us immediately of unauthorized access at support@tataiya.in.</li>
</ul>

<h2>4. Subscriptions &amp; Billing</h2>
<p>Paid plans (for example, Standard) grant access for the billed period. Subscriptions may renew automatically unless cancelled before renewal. Prices may change with reasonable notice. Taxes may apply.</p>

<h2>5. License to Stream</h2>
<p>Content is licensed for <strong>personal, non-commercial</strong> viewing only. You may not copy, redistribute, publicly display, reverse-engineer, or circumvent technical protections (including DRM/HLS restrictions), except where the product expressly allows downloads for offline personal use.</p>

<h2>6. Prohibited Conduct</h2>
<ul>
  <li>Allowing anyone under 18 to use your account or watch content</li>
  <li>Uploading illegal material or attempting to hack the platform</li>
  <li>Scraping, bulk downloading, or redistributing movies</li>
  <li>Harassing staff or other users</li>
  <li>Using VPN/proxy solely to evade regional licensing or bans (where restricted)</li>
</ul>

<h2>7. Cancellation</h2>
<p>You may cancel anytime in account settings. Access continues until the end of the paid period. Refunds are governed by our <a href="/page/refund-policy">Refund Policy</a>.</p>

<h2>8. Disclaimers</h2>
<p>Content is provided "as is." We do not guarantee uninterrupted availability, error-free playback, or that every title will remain in the catalogue. Opinions expressed in films do not necessarily reflect Tataiya's views.</p>

<h2>9. Limitation of Liability</h2>
<p>To the fullest extent permitted by law, Tataiya is not liable for indirect, incidental, special, or consequential damages arising from your use of the service or any 18+ content you choose to watch.</p>

<h2>10. Termination</h2>
<p>We may suspend or terminate accounts that violate these Terms, the age policy, or applicable law, without refund where termination is for misconduct.</p>

<h2>11. Governing Law</h2>
<p>These Terms are governed by the laws of India. Courts in India shall have exclusive jurisdiction, subject to mandatory consumer protections that may apply.</p>

<h2>Contact</h2>
<p>Legal: <strong>legal@tataiya.in</strong> · Support: <strong>support@tataiya.in</strong></p>`,
  },
  {
    title: 'Age Limits',
    slug: 'age-limits',
    order: 3,
    metaTitle: 'Age Limits & 18+ Policy | Tataiya',
    metaDescription: 'Tataiya is strictly 18+. Learn our age limits, ratings, and parental responsibility rules.',
    content: `<h1>Age Limits &amp; 18+ Policy</h1>
<p>Last updated: July 2026</p>
<p>Tataiya is an <strong>adults-only streaming platform</strong>. All catalogue titles are intended for viewers aged <strong>18 years and above</strong>.</p>

<h2>1. Hard Age Gate</h2>
<ul>
  <li>You must be <strong>18+</strong> to register, subscribe, or stream.</li>
  <li>By signing up you confirm your age and accept responsibility for viewing mature content.</li>
  <li>We reserve the right to request age verification and to close accounts that appear to belong to minors.</li>
</ul>

<h2>2. What “18+” Means on Tataiya</h2>
<p>Movies may contain one or more of the following:</p>
<ul>
  <li>Strong sexual content or nudity</li>
  <li>Graphic violence or horror</li>
  <li>Strong language and adult themes</li>
  <li>Substance use or other mature situations</li>
</ul>
<p>Individual titles may also show a numeric age rating (for example <strong>18+</strong>). When in doubt, treat every title as adult content.</p>

<h2>3. Parental / Guardian Responsibility</h2>
<p>Tataiya is <strong>not designed for children or family co-viewing</strong>. If you share devices:</p>
<ul>
  <li>Log out after watching</li>
  <li>Do not save passwords on shared devices used by minors</li>
  <li>Use device-level screen locks and OS parental controls</li>
</ul>
<p>Parents and guardians are responsible for preventing minors from accessing adult accounts and content.</p>

<h2>4. Profiles &amp; Kids Mode</h2>
<p>Tataiya does <strong>not</strong> offer a kids profile or under-18 catalogue. Do not create accounts for children.</p>

<h2>5. Geographic &amp; Legal Compliance</h2>
<p>Adult content laws vary by country and state. You must only use Tataiya where you are legally allowed to view 18+ material. You are responsible for complying with local law.</p>

<h2>6. Reporting Underage Access</h2>
<p>If you believe a minor has an account or is accessing Tataiya, email <strong>safety@tataiya.in</strong> with details. We will investigate and take appropriate action, including account deletion.</p>

<h2>Related Policies</h2>
<ul>
  <li><a href="/page/content-guidelines">Content Guidelines</a></li>
  <li><a href="/page/terms-and-conditions">Terms and Conditions</a></li>
  <li><a href="/page/disclaimer">Disclaimer</a></li>
</ul>`,
  },
  {
    title: 'Content Guidelines',
    slug: 'content-guidelines',
    order: 4,
    metaTitle: 'Content Guidelines | Tataiya',
    metaDescription: 'How Tataiya labels and presents 18+ movies, and what we do not allow.',
    content: `<h1>Content Guidelines</h1>
<p>Last updated: July 2026</p>
<p>These guidelines explain how Tataiya presents mature movies and what content standards we apply.</p>

<h2>1. Adult Entertainment Focus</h2>
<p>Our catalogue focuses on <strong>18+ movies</strong> — thrillers, drama, romance, horror, and other genres with adult themes. Titles are curated for adult audiences only.</p>

<h2>2. Labelling</h2>
<ul>
  <li>Titles may display age ratings such as <strong>18+</strong>.</li>
  <li>Descriptions, posters, and trailers may still contain suggestive imagery appropriate to an adult service.</li>
  <li>We strive for accurate genre and language metadata so you can choose what to watch.</li>
</ul>

<h2>3. What We Do Not Host</h2>
<p>Tataiya does not permit:</p>
<ul>
  <li>Any sexual content involving minors (or anyone who appears to be under 18) — zero tolerance</li>
  <li>Non-consensual real-world exploitation material</li>
  <li>Illegal content under applicable Indian law</li>
  <li>Pirated uploads from unauthorized sources outside our licensed catalogue</li>
</ul>

<h2>4. User Conduct Around Content</h2>
<ul>
  <li>Do not record, re-upload, or redistribute Tataiya streams</li>
  <li>Do not use our titles to harass or target others</li>
  <li>Reviews and comments (where enabled) must stay lawful and respectful</li>
</ul>

<h2>5. Reporting</h2>
<p>To report a title you believe violates these guidelines or the law, contact <strong>content@tataiya.in</strong> with the movie name and reason. We will review and act as appropriate.</p>

<p>See also: <a href="/page/age-limits">Age Limits</a> · <a href="/page/disclaimer">Disclaimer</a></p>`,
  },
  {
    title: 'Disclaimer',
    slug: 'disclaimer',
    order: 5,
    metaTitle: 'Disclaimer | Tataiya',
    metaDescription: 'Legal disclaimer for Tataiya 18+ movie streaming.',
    content: `<h1>Disclaimer</h1>
<p>Last updated: July 2026</p>

<h2>Adult Content</h2>
<p>All content on Tataiya is intended for <strong>adults 18 years of age or older</strong>. By entering the site or app you confirm you are of legal age and wish to view mature material.</p>

<h2>No Professional Advice</h2>
<p>Movies and related materials are for entertainment only. They do not constitute legal, medical, financial, or professional advice.</p>

<h2>External Links</h2>
<p>We may link to third-party sites or payment providers. Tataiya is not responsible for their content, privacy practices, or availability.</p>

<h2>Availability</h2>
<p>Titles, features, and streaming quality may change or become unavailable without notice due to licensing, maintenance, or technical issues.</p>

<h2>Liability</h2>
<p>Your use of Tataiya is at your own risk. To the maximum extent permitted by law, Tataiya disclaims liability for damages arising from viewing decisions, account misuse, or service interruptions.</p>

<p>Questions: <strong>legal@tataiya.in</strong></p>`,
  },
  {
    title: 'About Us',
    slug: 'about-us',
    order: 6,
    metaTitle: 'About Tataiya',
    metaDescription: 'Tataiya is an 18+ movie streaming platform for adult audiences.',
    content: `<h1>About Tataiya</h1>
<p>Tataiya is a premium <strong>adults-only (18+)</strong> OTT platform built for movie lovers who want bold storytelling, intense drama, thrillers, and mature cinema — streamed in high quality on web and mobile.</p>

<h2>Our Focus</h2>
<ul>
  <li><strong>Movies first</strong> — a curated adult catalogue, not a kids or family service</li>
  <li><strong>Clear age policy</strong> — 18+ only, with transparent ratings and guidelines</li>
  <li><strong>Simple plans</strong> — straightforward subscription access without coin gimmicks</li>
  <li><strong>Modern streaming</strong> — adaptive HLS playback and a clean viewing experience</li>
</ul>

<h2>Our Promise</h2>
<p>We respect that adult entertainment is for consenting adults. We invest in safety policies, privacy, and a catalogue that stays within legal and ethical bounds while delivering entertainment that feels premium.</p>

<h2>Contact</h2>
<p>Hello: <strong>hello@tataiya.in</strong><br/>Support: <strong>support@tataiya.in</strong><br/>Web: <strong>https://tataiya.in</strong></p>`,
  },
  {
    title: 'Contact Us',
    slug: 'contact',
    order: 7,
    metaTitle: 'Contact Us | Tataiya',
    metaDescription: 'Contact Tataiya support, billing, legal, and safety teams.',
    content: `<h1>Contact Us</h1>
<p>We're here to help with accounts, billing, playback, and safety concerns on our 18+ movie platform.</p>

<h2>Customer Support</h2>
<ul>
  <li><strong>Email:</strong> support@tataiya.in</li>
  <li><strong>Typical response:</strong> within 24 hours on business days</li>
</ul>

<h2>Billing &amp; Refunds</h2>
<ul>
  <li><strong>Email:</strong> billing@tataiya.in</li>
  <li>Also see our <a href="/page/refund-policy">Refund Policy</a></li>
</ul>

<h2>Privacy</h2>
<ul>
  <li><strong>Email:</strong> privacy@tataiya.in</li>
  <li><a href="/page/privacy-policy">Privacy Policy</a></li>
</ul>

<h2>Safety &amp; Underage Reports</h2>
<ul>
  <li><strong>Email:</strong> safety@tataiya.in</li>
  <li><a href="/page/age-limits">Age Limits</a></li>
</ul>

<h2>Legal &amp; Content</h2>
<ul>
  <li><strong>Legal:</strong> legal@tataiya.in</li>
  <li><strong>Content reports:</strong> content@tataiya.in</li>
</ul>

<h2>Website</h2>
<p><strong>https://tataiya.in</strong></p>`,
  },
  {
    title: 'Cookie Policy',
    slug: 'cookie-policy',
    order: 8,
    metaTitle: 'Cookie Policy | Tataiya',
    metaDescription: 'How Tataiya uses cookies on our 18+ streaming website.',
    content: `<h1>Cookie Policy</h1>
<p>Last updated: July 2026</p>
<p>This policy explains how Tataiya uses cookies and similar technologies on <strong>tataiya.in</strong>.</p>

<h2>What Are Cookies?</h2>
<p>Cookies are small files stored on your device that help the site remember logins, preferences, and usage patterns.</p>

<h2>Cookies We Use</h2>
<h3>Essential</h3>
<p>Required for login, security, age-gate confirmation, and core streaming features.</p>
<h3>Preferences</h3>
<p>Remember language, player settings, and similar choices.</p>
<h3>Analytics</h3>
<p>Help us understand how adults use the catalogue so we can improve performance and discovery.</p>
<h3>Marketing (if enabled)</h3>
<p>Measure campaigns. We do not use cookies to target children.</p>

<h2>Managing Cookies</h2>
<p>You can block or delete cookies in your browser settings. Blocking essential cookies may break login or playback.</p>

<h2>Contact</h2>
<p><strong>privacy@tataiya.in</strong></p>`,
  },
  {
    title: 'Help Center',
    slug: 'help',
    order: 9,
    metaTitle: 'Help Center | Tataiya',
    metaDescription: 'Help for Tataiya accounts, subscriptions, streaming, and 18+ access.',
    content: `<h1>Help Center</h1>
<p>Quick answers for Tataiya — 18+ movie streaming.</p>

<h2>Age &amp; Access</h2>
<h3>Why is Tataiya 18+ only?</h3>
<p>Our catalogue contains mature movies. You must be 18 or older. See <a href="/page/age-limits">Age Limits</a>.</p>
<h3>Is there a kids mode?</h3>
<p>No. Tataiya does not offer children's profiles or family catalogues.</p>

<h2>Account &amp; Subscription</h2>
<h3>How do I subscribe?</h3>
<p>Sign in, open Plans / Subscription, choose Standard (or the plan shown), and complete payment.</p>
<h3>How do I cancel?</h3>
<p>Account Settings → Subscription → Cancel. Access continues until the period ends.</p>
<h3>Forgot password?</h3>
<p>Use Forgot Password on the login page and follow the email link.</p>

<h2>Streaming</h2>
<h3>Video buffering?</h3>
<ul>
  <li>Check your connection</li>
  <li>Lower quality in the player</li>
  <li>Close other apps/tabs</li>
  <li>Retry on another network</li>
</ul>
<h3>Can I download movies?</h3>
<p>Where enabled for your plan, use the download option in the app/site for offline personal viewing only.</p>

<h2>Still need help?</h2>
<p>Email <strong>support@tataiya.in</strong> or visit <a href="/page/contact">Contact Us</a>.</p>`,
  },
  {
    title: 'Refund Policy',
    slug: 'refund-policy',
    order: 10,
    metaTitle: 'Refund Policy | Tataiya',
    metaDescription: 'Refund and billing policy for Tataiya subscriptions.',
    content: `<h1>Refund Policy</h1>
<p>Last updated: July 2026</p>
<p>Please read this before subscribing to Tataiya.</p>

<h2>General Rule</h2>
<p>Subscription fees are generally <strong>non-refundable</strong> for partial periods. When you pay, you purchase access for that billing cycle.</p>

<h2>Exceptions</h2>
<ul>
  <li><strong>Unauthorized charges:</strong> Contact billing@tataiya.in immediately. Confirmed fraud may receive a full refund.</li>
  <li><strong>Extended outage:</strong> If a platform-wide failure prevents streaming for several consecutive days, we may offer credit at our discretion.</li>
  <li><strong>Duplicate charges:</strong> Verified duplicate payments will be refunded or credited.</li>
</ul>

<h2>How to Request</h2>
<ol>
  <li>Email <strong>billing@tataiya.in</strong> with your account email and reason</li>
  <li>We review within about 3 business days</li>
  <li>Approved refunds return to the original payment method in 5–7 business days (processor dependent)</li>
</ol>

<h2>Cancellations</h2>
<p>Cancel anytime to stop the next renewal. Cancellation does not automatically refund the current period.</p>

<p>Support: <strong>support@tataiya.in</strong></p>`,
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

  // Normalize legacy slug
  await db.collection('pages').updateOne(
    { slug: 'terms-of-service' },
    {
      $set: {
        slug: 'terms-and-conditions',
        title: 'Terms and Conditions',
        updatedAt: new Date(),
      },
    }
  );

  for (const page of PAGES) {
    const result = await db.collection('pages').updateOne(
      { slug: page.slug },
      {
        $set: {
          title: page.title,
          slug: page.slug,
          content: page.content,
          status: 'published',
          order: page.order,
          metaTitle: page.metaTitle,
          metaDescription: page.metaDescription,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    const action = result.upsertedCount ? 'created' : 'updated';
    console.log(`${action}: ${page.slug}`);
  }

  const all = await db
    .collection('pages')
    .find({})
    .project({ title: 1, slug: 1, status: 1, order: 1 })
    .sort({ order: 1 })
    .toArray();

  console.log('\nPublished pages:');
  for (const p of all) {
    console.log(`  [${p.order}] ${p.title} (/page/${p.slug}) — ${p.status}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
