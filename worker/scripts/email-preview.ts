// Renders every Split email to worker/.email-preview/ for a quick look in a browser.
//   npm run email:preview --prefix worker
// Each email is written as <name>.html and <name>.txt, plus index.html with
// light and dark frames side by side.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDigest, renderGroupInvite, renderSignInReminder, renderSignupInvite, type RenderedEmail } from '../src/emailTemplate.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '.email-preview');
const links = {
  logoURL: 'https://split.yoinklabs.dev/icon.png',
  unsubscribeURL: 'https://split-api.yoinklabs.dev/email/unsubscribe?t=preview&k=expenses',
  preferencesURL: 'https://split-api.yoinklabs.dev/email/preferences?t=preview',
};
const group = 'Lisbon weekend';
const emails: Record<string, RenderedEmail> = {
  'invite-member': renderGroupInvite({ inviter: 'Alex Rivera', group, url: 'https://split.yoinklabs.dev/invites', ...links }),
  'invite-added': renderGroupInvite({ inviter: 'Alex Rivera', group, url: 'https://split.yoinklabs.dev/g/demo', added: true, ...links }),
  'invite-signup': renderSignupInvite({ inviter: 'Alex Rivera', group, url: 'https://split-api.yoinklabs.dev/join/ABCD2345EFGH', days: 7, logoURL: links.logoURL }),
  'sign-in-reminder': renderSignInReminder({ group, url: 'https://split.yoinklabs.dev/g/demo', logoURL: links.logoURL }),
  'activity-single': renderDigest({ group, url: 'https://split.yoinklabs.dev/g/demo', ...links, items: [
    { kind: 'expenses', actor: 'Alex', title: 'Dinner at Taberna', amount: 12840, currency: 'EUR', share: 3210 },
  ] }),
  'activity-digest': renderDigest({ group, url: 'https://split.yoinklabs.dev/g/demo', ...links, items: [
    { kind: 'expenses', actor: 'Alex', title: 'Dinner at Taberna', amount: 12840, currency: 'EUR', share: 3210 },
    { kind: 'payments', actor: 'Maya', amount: 4500, currency: 'EUR', variant: 'paidYou' },
    { kind: 'settleRequests', actor: 'Sam', amount: 2000, currency: 'EUR' },
    { kind: 'credits', actor: 'Alex', title: 'Museum tickets', amount: 1200, currency: 'EUR', variant: 'refund' },
    { kind: 'pendingResolved', actor: 'Maya', title: 'Hotel deposit', amount: 30000, currency: 'EUR', share: 7500 },
  ] }),
};

mkdirSync(out, { recursive: true });
const frames: string[] = [];
for (const [name, email] of Object.entries(emails)) {
  writeFileSync(join(out, name + '.html'), email.html);
  writeFileSync(join(out, name + '.txt'), `Subject: ${email.subject}\n\n${email.text}\n`);
  // Dark frames force the dark media query by swapping it to `all`.
  writeFileSync(join(out, name + '.dark.html'), email.html.replace('@media (prefers-color-scheme:dark)', '@media all'));
  frames.push(`<section><h2>${name}</h2><p><code>${email.subject.replace(/</g, '&lt;')}</code></p>
    <div class="pair"><iframe src="${name}.html"></iframe><iframe src="${name}.dark.html"></iframe></div></section>`);
}
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Split email preview</title>
<style>body{font:14px system-ui;margin:24px;background:#ddd}.pair{display:flex;gap:16px}iframe{width:600px;height:760px;border:0;background:#fff;border-radius:8px}</style>
${frames.join('\n')}`);
console.log(`Wrote ${Object.keys(emails).length} emails to ${out}/ (open index.html)`);
