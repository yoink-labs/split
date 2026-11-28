// Split-branded transactional email templates. Every email has an HTML body
// that reads well in light and dark mail clients and a plain-text twin.
// This module is pure (no Env, no I/O) so the preview script can run it in Node.

export const activityKinds = ['expenses', 'payments', 'settleRequests', 'credits', 'pendingResolved', 'receiptStatus'] as const;
export type ActivityKind = typeof activityKinds[number];
export const emailKinds = ['invites', ...activityKinds] as const;
export type EmailKind = typeof emailKinds[number];
export const kindLabels: Record<EmailKind, string> = {
  invites: 'Group invitations',
  expenses: 'New expenses that include you',
  payments: 'Payments to or from you',
  settleRequests: 'Settle-up requests',
  credits: 'Refunds and credits to you',
  pendingResolved: 'Pending expenses being resolved',
  receiptStatus: 'Receipts closing or reopening',
};

export interface ActivityItem {
  kind: ActivityKind;
  actor: string;
  title?: string;
  amount?: number;
  currency?: string;
  share?: number;
  // payments: 'paidYou' (actor paid you), 'receivedYours' (actor recorded your
  // payment to them), 'confirmed' or 'declined' (actor answered your request).
  // credits: 'refund' or 'credit'.
  variant?: string;
}

export interface RenderedEmail { subject: string; html: string; text: string }
interface Footer { reason: string; unsubscribeURL?: string; preferencesURL?: string }

const brand = {
  lime: '#d1f091', forest: '#12382b', button: '#183f34',
  light: { bg: '#f4f3ee', card: '#ffffff', ink: '#172e27', muted: '#5b6b63', line: '#e3e6df', chip: '#eef5df' },
  dark: { bg: '#101b17', card: '#16241f', ink: '#edf3ea', muted: '#a6b5ad', line: '#2a3a33', chip: '#1f3329' },
};
const font = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHTML(value: string) {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Formats integer minor units exactly; the decimal is built as a string, never a float. */
export function money(minor: number, currency: string) {
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  const sign = minor < 0 ? '-' : '';
  const raw = String(Math.abs(Math.trunc(minor))).padStart(digits + 1, '0');
  const decimal = digits ? raw.slice(0, -digits) + '.' + raw.slice(-digits) : raw;
  return format.format((sign + decimal) as unknown as number);
}

const quote = (title?: string) => title ? `“${title}”` : 'an expense';

export function describe(item: ActivityItem): { line: string; detail?: string } {
  const amount = item.amount !== undefined && item.currency ? money(item.amount, item.currency) : undefined;
  const share = item.share !== undefined && item.currency ? money(item.share, item.currency) : undefined;
  switch (item.kind) {
    case 'expenses':
      return { line: `${item.actor} added ${quote(item.title)}${amount ? ' · ' + amount : ''}`,
        detail: share ? `Your share: ${share}` : undefined };
    case 'payments': {
      const what = amount ? `${amount} payment` : 'payment';
      const line = item.variant === 'paidYou' ? `${item.actor} recorded a ${what} to you`
        : item.variant === 'confirmed' ? `${item.actor} confirmed your ${what}`
        : item.variant === 'declined' ? `${item.actor} declined your ${what}`
        : `${item.actor} recorded your ${what}`;
      return { line };
    }
    case 'settleRequests':
      return { line: `${item.actor} asked you to confirm a ${amount ? amount + ' ' : ''}payment`,
        detail: 'Open Split to approve or decline it.' };
    case 'credits': {
      const label = item.variant === 'credit' ? 'credit' : 'refund';
      return { line: `${item.actor} recorded a ${amount ? amount + ' ' : ''}${label} to you`,
        detail: item.title ? `For ${quote(item.title)}` : undefined };
    }
    case 'receiptStatus':
      return { line: `${quote(item.title)} ${item.variant === 'reopened' ? 'reopened' : 'closed'} after ${item.actor} updated the receipt` };
    case 'pendingResolved':
      return { line: `${item.actor} resolved the pending expense ${quote(item.title)}`,
        detail: share ? `Your share: ${share}` : amount ? `Total: ${amount}` : undefined };
  }
}

function layout(o: { preheader: string; heading: string; paragraphs: string[]; rows?: string; cta?: { label: string; url: string }; note?: string; footer: Footer; logoURL: string }) {
  const L = brand.light, D = brand.dark;
  const footerLinks = [
    o.footer.preferencesURL ? `<a href="${escapeHTML(o.footer.preferencesURL)}" class="muted" style="color:${L.muted};text-decoration:underline">Email preferences</a>` : '',
    o.footer.unsubscribeURL ? `<a href="${escapeHTML(o.footer.unsubscribeURL)}" class="muted" style="color:${L.muted};text-decoration:underline">Unsubscribe</a>` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHTML(o.heading)}</title>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0;-webkit-text-size-adjust:100%}
a{color:${L.ink}}
@media (prefers-color-scheme:dark){
  .page{background:${D.bg}!important}
  .card{background:${D.card}!important;border-color:${D.line}!important}
  .ink,.ink a{color:${D.ink}!important}
  .muted,.muted a{color:${D.muted}!important}
  .row{border-color:${D.line}!important}
  .chip{background:${D.chip}!important;color:${D.ink}!important}
  .btn{background:${brand.lime}!important;color:${brand.forest}!important}
  .btn a{color:${brand.forest}!important}
}
[data-ogsc] .page{background:${D.bg}!important}
[data-ogsc] .card{background:${D.card}!important}
[data-ogsc] .ink{color:${D.ink}!important}
[data-ogsc] .muted{color:${D.muted}!important}
[data-ogsb] .btn{background:${brand.lime}!important}
[data-ogsc] .btn a{color:${brand.forest}!important}
@media (max-width:520px){.card{border-radius:0!important}.pad{padding:24px 20px!important}}
</style>
</head>
<body class="page" style="margin:0;padding:0;background:${L.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHTML(o.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="page" style="background:${L.bg}">
<tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
<tr><td style="padding:0 4px 18px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="vertical-align:middle"><img src="${escapeHTML(o.logoURL)}" width="36" height="36" alt="Split" style="display:block;border:0;border-radius:9px"></td>
    <td class="ink" style="vertical-align:middle;padding-left:10px;font:700 19px/1 ${font};color:${L.ink};letter-spacing:-0.2px">Split</td>
  </tr></table>
</td></tr>
<tr><td class="card pad" style="background:${L.card};border:1px solid ${L.line};border-radius:20px;padding:32px 30px">
  <h1 class="ink" style="margin:0 0 14px;font:700 23px/1.25 ${font};color:${L.ink};letter-spacing:-0.3px">${escapeHTML(o.heading)}</h1>
  ${o.paragraphs.map(p => `<p class="ink" style="margin:0 0 14px;font:400 16px/1.55 ${font};color:${L.ink}">${p}</p>`).join('\n  ')}
  ${o.rows ?? ''}
  ${o.cta ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px"><tr>
    <td class="btn" style="background:${brand.button};border-radius:14px">
      <a href="${escapeHTML(o.cta.url)}" style="display:inline-block;padding:14px 26px;font:600 16px/1 ${font};color:#ffffff;text-decoration:none;border-radius:14px">${escapeHTML(o.cta.label)}</a>
    </td></tr></table>` : ''}
  ${o.note ? `<p class="muted" style="margin:18px 0 0;font:400 13px/1.5 ${font};color:${L.muted}">${o.note}</p>` : ''}
</td></tr>
<tr><td class="muted" style="padding:20px 8px 0;font:400 12px/1.6 ${font};color:${L.muted};text-align:center">
  ${escapeHTML(o.footer.reason)}${footerLinks ? '<br>' + footerLinks : ''}<br>
  Split by Yoink Labs
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function textFooter(f: Footer) {
  return ['', '—', f.reason, f.preferencesURL ? `Email preferences: ${f.preferencesURL}` : '',
    f.unsubscribeURL ? `Unsubscribe: ${f.unsubscribeURL}` : '', 'Split by Yoink Labs'].filter(Boolean).join('\n');
}

export interface Links { logoURL: string; unsubscribeURL?: string; preferencesURL?: string }

/** A signed-up Split user was invited to (or added to) a group. */
export function renderGroupInvite(o: { inviter: string; group: string; url: string; added?: boolean } & Links): RenderedEmail {
  const subject = o.added ? `${o.inviter} added you to ${o.group}` : `${o.inviter} invited you to ${o.group}`;
  const footer = { reason: 'You received this because someone invited your Split account to a group.', unsubscribeURL: o.unsubscribeURL, preferencesURL: o.preferencesURL };
  const lead = o.added
    ? `<strong>${escapeHTML(o.inviter)}</strong> added you to <strong>${escapeHTML(o.group)}</strong> on Split. You can see shared expenses and balances there now.`
    : `<strong>${escapeHTML(o.inviter)}</strong> invited you to join <strong>${escapeHTML(o.group)}</strong> on Split. Accept or decline it from your invitations.`;
  const cta = o.added ? 'Open group' : 'View invitation';
  return {
    subject,
    html: layout({ preheader: subject, heading: subject, paragraphs: [lead], cta: { label: cta, url: o.url }, footer, logoURL: o.logoURL }),
    text: [subject, '', o.added ? `${o.inviter} added you to ${o.group} on Split.` : `${o.inviter} invited you to join ${o.group} on Split. Accept or decline it from your invitations.`,
      '', `${cta}: ${o.url}`, textFooter(footer)].join('\n'),
  };
}

/** Someone without a Split account was invited by email to claim a placeholder seat. */
export function renderSignupInvite(o: { inviter: string; group: string; url: string; days: number } & Links): RenderedEmail {
  const subject = `${o.inviter} invited you to ${o.group} on Split`;
  const footer = { reason: `You received this because ${o.inviter} entered your email address in Split. If you weren’t expecting it, you can ignore it.` };
  const lead = `<strong>${escapeHTML(o.inviter)}</strong> is splitting expenses in <strong>${escapeHTML(o.group)}</strong> and saved a place for you.`;
  const how = `Create a free Split account or sign in with <strong>this email address</strong>, and you’ll land straight in the group.`;
  return {
    subject,
    html: layout({ preheader: `Join ${o.group} to see what you owe and are owed.`, heading: `Join ${o.group} on Split`,
      paragraphs: [lead, how], cta: { label: 'Join the group', url: o.url },
      note: `This link expires in ${o.days} days and only works for this email address.`, footer, logoURL: o.logoURL }),
    text: [`Join ${o.group} on Split`, '', `${o.inviter} is splitting expenses in ${o.group} and saved a place for you.`,
      'Create a free Split account or sign in with this email address, and you’ll land straight in the group.', '',
      `Join the group: ${o.url}`, '', `This link expires in ${o.days} days and only works for this email address.`, textFooter(footer)].join('\n'),
  };
}

/** A group member nudged a joined member to sign in. */
export function renderSignInReminder(o: { group: string; url: string } & Links): RenderedEmail {
  const subject = 'Sign in to Split';
  const footer = { reason: 'You received this because a member of your group sent you a reminder.' };
  return {
    subject,
    html: layout({ preheader: `Your group ${o.group} is waiting for you.`, heading: subject,
      paragraphs: [`A member of <strong>${escapeHTML(o.group)}</strong> sent you a reminder to sign in to Split and check the group.`],
      cta: { label: 'Open group', url: o.url }, footer, logoURL: o.logoURL }),
    text: [subject, '', `A member of ${o.group} sent you a reminder to sign in to Split and check the group.`, '', `Open group: ${o.url}`, textFooter(footer)].join('\n'),
  };
}

/** One or more activity updates in a group, batched into a single email. */
export function renderDigest(o: { group: string; items: ActivityItem[]; url: string } & Links): RenderedEmail {
  const lines = o.items.map(describe);
  const subject = lines.length === 1 ? `${lines[0].line} in ${o.group}` : `${lines.length} updates in ${o.group}`;
  const footer = { reason: `You received this because of activity in ${o.group} that involves you.`, unsubscribeURL: o.unsubscribeURL, preferencesURL: o.preferencesURL };
  const L = brand.light;
  const rows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px">
  ${lines.map((l, i) => `<tr><td class="row" style="padding:13px 0;${i ? `border-top:1px solid ${L.line};` : ''}">
    <div class="ink" style="font:600 15px/1.45 ${font};color:${L.ink}">${escapeHTML(l.line)}</div>
    ${l.detail ? `<div class="muted" style="font:400 14px/1.45 ${font};color:${L.muted};margin-top:2px">${escapeHTML(l.detail)}</div>` : ''}
  </td></tr>`).join('\n  ')}
  </table>`;
  const heading = lines.length === 1 ? `New in ${o.group}` : `${lines.length} updates in ${o.group}`;
  return {
    subject,
    html: layout({ preheader: lines.map(l => l.line).join(' · ').slice(0, 140), heading, paragraphs: [], rows,
      cta: { label: 'Open group', url: o.url }, footer, logoURL: o.logoURL }),
    text: [heading, '', ...lines.flatMap(l => ['• ' + l.line, ...(l.detail ? ['  ' + l.detail] : [])]), '', `Open group: ${o.url}`, textFooter(footer)].join('\n'),
  };
}

/** Small HTML page for the unsubscribe flow, in the same palette. */
export function renderPage(o: { title: string; message: string; form?: { action: string; label: string; secondary?: { action: string; label: string } }; logoURL: string }) {
  const L = brand.light, D = brand.dark;
  const button = (action: string, label: string, primary: boolean) => `<form method="post" action="${escapeHTML(action)}" style="margin:0 0 10px">
    <button type="submit" class="${primary ? 'btn' : 'ghost'}">${escapeHTML(label)}</button></form>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${escapeHTML(o.title)} · Split</title>
<style>body{font:17px/1.55 ${font};background:${L.bg};color:${L.ink};max-width:460px;margin:8vh auto;padding:0 24px}
.card{background:${L.card};border:1px solid ${L.line};border-radius:20px;padding:28px}
button{font:600 16px ${font};width:100%;padding:15px;border-radius:14px;cursor:pointer;border:0}
.btn{background:${brand.button};color:#fff}.ghost{background:transparent;color:${L.ink};border:1px solid ${L.line}}
@media(prefers-color-scheme:dark){body{background:${D.bg};color:${D.ink}}.card{background:${D.card};border-color:${D.line}}
.btn{background:${brand.lime};color:${brand.forest}}.ghost{color:${D.ink};border-color:${D.line}}}</style>
<p><img src="${escapeHTML(o.logoURL)}" width="44" height="44" alt="Split" style="border-radius:11px"></p>
<div class="card"><h1 style="margin:0 0 10px;font-size:23px">${escapeHTML(o.title)}</h1><p style="margin:0 0 20px">${escapeHTML(o.message)}</p>
${o.form ? button(o.form.action, o.form.label, true) + (o.form.secondary ? button(o.form.secondary.action, o.form.secondary.label, false) : '') : ''}</div></html>`;
}
