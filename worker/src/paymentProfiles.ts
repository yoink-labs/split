import { body, HTTPError, json } from './http';
import { InputError } from './ledger';

import type { PaymentMethod } from './paymentTypes';

const legacyPatterns = {
  venmo: /^[A-Za-z0-9_-]{1,40}$/,
  paypal: /^[A-Za-z0-9]{1,40}$/,
  mercado: /^https:\/\/(?:link\.mercadopago\.com\.ar|mpago\.la|mpago\.ar)\/[\w-]{1,100}\/?$/,
  alias: /^(?:[0-9]{22}|[a-zA-Z0-9.-]{6,20})$/,
};

export function paymentMethods(details: string | null | undefined): PaymentMethod[] | undefined {
  if (details == null) return undefined;
  const value = JSON.parse(details);
  if (Array.isArray(value)) return value;
  return Object.keys(legacyPatterns).flatMap(platform => value[platform] ? [{ platform, handle: value[platform] }] : []);
}

export function legacyPayment(methods: PaymentMethod[]) {
  return Object.fromEntries(methods
    .filter(({ platform, handle }) => Object.hasOwn(legacyPatterns, platform) && legacyPatterns[platform as keyof typeof legacyPatterns].test(handle))
    .map(({ platform, handle }) => [platform, handle]));
}

export function validateMethods(value: unknown): PaymentMethod[] {
  if (!Array.isArray(value) || value.length > 20) throw new InputError('Add up to 20 payment methods.');
  let hasPreferred = false;
  return value.map(row => {
    if (!row || typeof row !== 'object' || typeof row.platform !== 'string' || typeof row.handle !== 'string')
      throw new InputError('Enter a platform and a payment handle.');
    const platform = row.platform.trim(), handle = row.handle.trim();
    if (!platform || platform.length > 60 || !handle || handle.length > 500 || /[\u0000-\u001f\u007f]/.test(platform + handle))
      throw new InputError('Enter a platform up to 60 characters and a handle up to 500 characters on one line.');
    if (row.preferred === true) {
      if (hasPreferred) throw new InputError('Choose one preferred payment method.');
      hasPreferred = true;
      return { platform, handle, preferred: true };
    }
    return { platform, handle };
  });
}

export async function saveAccountPayments(request: Request, db: D1Database, user: string) {
  const { methods, shareWithFriends } = await body(request, 65536);
  if (shareWithFriends !== undefined && typeof shareWithFriends !== 'boolean')
    throw new InputError('Choose whether friends can see your payment methods.');
  const sharing = shareWithFriends === undefined ? null : Number(shareWithFriends);
  await db.prepare(`INSERT INTO account_payment_profiles(user_id,details,share_with_friends) VALUES (?,?,COALESCE(?,0))
    ON CONFLICT(user_id) DO UPDATE SET details=excluded.details,
      share_with_friends=COALESCE(?,account_payment_profiles.share_with_friends)`)
    .bind(user, JSON.stringify(validateMethods(methods)), sharing, sharing).run();
  return json({ ok: true });
}

export async function saveGroupPayments(db: D1Database, group: string, user: string, input: Record<string, unknown>) {
  let details: PaymentMethod[] | Record<string, string> | null;
  if (Object.hasOwn(input, 'methods')) {
    details = input.methods === null ? null : validateMethods(input.methods);
  } else {
    // Keep older clients working with their existing group form.
    details = {};
    for (const [platform, pattern] of Object.entries(legacyPatterns)) {
      const handle = input[platform];
      if (!handle) continue;
      if (typeof handle !== 'string' || !pattern.test(handle)) throw new InputError('Check your payment handles, Argentine alias or CVU.');
      details[platform] = handle;
    }
  }

  const activeSeat = 'SELECT id FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL';
  if (details === null) {
    const result = await db.prepare(`DELETE FROM payment_profiles WHERE member_id IN (${activeSeat})`).bind(group, user).run();
    if (!result.meta.changes && !await db.prepare(activeSeat).bind(group, user).first())
      throw new HTTPError(403, 'Only active members can change their group payment methods.');
  } else {
    const result = await db.prepare(`INSERT INTO payment_profiles(member_id,details)
      SELECT id,? FROM (${activeSeat}) WHERE true ON CONFLICT(member_id) DO UPDATE SET details=excluded.details`)
      .bind(JSON.stringify(details), group, user).run();
    if (!result.meta.changes) throw new HTTPError(403, 'Only active members can change their group payment methods.');
  }
  return json({ ok: true });
}
