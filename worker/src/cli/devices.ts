import { body, HTTPError, json } from '../http';

const digest = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
};
const secret = () => crypto.randomUUID() + crypto.randomUUID();
const lifetime = 600;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function deviceRoute(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  if (path === '/device' && request.method === 'GET') {
    return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect a computer · Split</title><main style="font:18px system-ui;max-width:32em;margin:10vh auto;padding:1em"><h1>Connect a computer</h1><p>Enter the code shown by <code>split login</code> on your own computer in one of these places, review its name and approve access:</p><ul><li>On the web: <a href="https://split.yoinklabs.dev/ai?tab=access&amp;action=pair">Split → AI &amp; CLI → Pair a computer</a></li><li>On iPhone: <strong>Split → You → Connected computers</strong></li></ul><p>Approval lets this computer read and change your Split groups and expenses. You can revoke access from the same screen.</p></main></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' }
    });
  }
  if (request.method !== 'POST') return null;
  const now = Date.now();
  if (path === '/v1/device/start') {
    const { name, scope = 'cli' } = await body(request);
    if (scope !== 'cli' && scope !== 'finance') throw new HTTPError(422, 'Unknown device access scope.');
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new HTTPError(422, 'Enter a device name (1–80 characters).');
    const device = secret();
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), n => alphabet[n % 32]).join('');
    const source = await digest(request.headers.get('CF-Connecting-IP') ?? 'local');
    const [, insert] = await env.DB.batch([
      env.DB.prepare('DELETE FROM cli_requests WHERE expires_at <= ?').bind(now),
      env.DB.prepare(`INSERT INTO cli_requests(device_hash, code_hash, source_hash, name, expires_at, scope)
        SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM cli_requests WHERE source_hash=?) < 15
        AND (SELECT count(*) FROM cli_requests) < 10000`)
        .bind(await digest(device), await digest(code), source, scope === 'finance' ? 'Finance (read-only)' : name.trim(), now + 1000 * lifetime, scope, source)
    ]);
    if (!insert.meta.changes) throw new HTTPError(429, 'Too many login requests. Try again in ten minutes.');
    return json({ device, code: code.slice(0,4) + '-' + code.slice(4), verification_uri: env.APP_URL + '/device', expires_in: lifetime, interval: 5, ...(scope === 'finance' ? { scope } : {}) }, 201);
  }
  if (path !== '/v1/device/poll') return null;
  const { device } = await body(request);
  if (typeof device !== 'string' || device.length !== 72) throw new HTTPError(400, 'Invalid device request.');
  const key = await digest(device);
  const row = await env.DB.prepare('SELECT approved_by,scope FROM cli_requests WHERE device_hash=? AND expires_at>?').bind(key,now).first();
  if (!row) throw new HTTPError(410, 'Code expired or already used. Run split login again.');
  if (!row.approved_by) return json({ status: 'pending' }, 202);
  const token = (row.scope === 'finance' ? 'sfi_' : 'spl_') + secret();
  const [insert] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO cli_tokens(id,token_hash,user_id,name,created_at,scope)
      SELECT ?,?,approved_by,name,?,scope FROM cli_requests WHERE device_hash=? AND approved_by IS NOT NULL AND expires_at>?`)
      .bind(crypto.randomUUID(), await digest(token), now, key, now),
    env.DB.prepare('DELETE FROM cli_requests WHERE device_hash=?').bind(key)
  ]);
  if (!insert.meta.changes) throw new HTTPError(410, 'Code already used.');
  return json({ token });
}

export async function deviceIdentity(env: Env, token: string) {
  const key = await digest(token);
  const row = await env.DB.prepare('SELECT id,user_id,last_used,scope,is_remote FROM cli_tokens WHERE token_hash=? AND revoked_at IS NULL')
    .bind(key).first<{ id: string; user_id: string; last_used: number | null; scope: 'cli' | 'finance'; is_remote: 0 | 1 }>();
  if (!row) throw new HTTPError(401, 'Device access expired or was revoked. Run split login.');
  if (Date.now() - (row.last_used ?? 0) > 60_000) {
    await env.DB.prepare('UPDATE cli_tokens SET last_used=? WHERE id=? AND revoked_at IS NULL').bind(Date.now(), row.id).run();
  }
  return row;
}

export async function manageDevices(request: Request, env: Env, user: string, deviceID?: string) {
  const path = new URL(request.url).pathname;
  if (path === '/v1/device/status' && request.method === 'GET') return json({ userID: user, deviceID });
  if (path === '/v1/device/logout' && request.method === 'POST' && deviceID) {
    await env.DB.prepare('UPDATE cli_tokens SET revoked_at=? WHERE id=? AND user_id=?').bind(Date.now(), deviceID, user).run();
    return json({ revoked: true });
  }
  if (deviceID) throw new HTTPError(403, 'Sign in to Split to manage connections.');
  if (path === '/v1/device/tokens' && request.method === 'GET') {
    return json((await env.DB.prepare('SELECT id,name,created_at,last_used,scope,is_remote FROM cli_tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC').bind(user).all()).results);
  }
  if (path === '/v1/device/tokens' && request.method === 'POST') {
    const input = await body(request, 1024);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw new HTTPError(422, 'Enter a token name (1–80 characters).');
    const connection = { id: crypto.randomUUID(), name, created_at: Date.now(), last_used: null, scope: 'cli', is_remote: 1 };
    const token = 'spl_' + secret();
    await env.DB.prepare('INSERT INTO cli_tokens(id,token_hash,user_id,name,created_at,scope,is_remote) VALUES (?,?,?,?,?,?,?)')
      .bind(connection.id, await digest(token), user, name, connection.created_at, connection.scope, connection.is_remote).run();
    return json({ connection, token }, 201);
  }
  if (path === '/v1/device/revoke' && request.method === 'POST') {
    const { id } = await body(request);
    if (typeof id !== 'string') throw new HTTPError(400, 'Choose a connection.');
    const result = await env.DB.prepare('UPDATE cli_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').bind(Date.now(), id, user).run();
    if (!result.meta.changes) throw new HTTPError(404, 'Connection not found.');
    return json({ revoked: true });
  }
  if (request.method === 'POST' && ['/v1/device/review','/v1/device/approve'].includes(path)) {
    const { code } = await body(request);
    const normalized = typeof code === 'string' ? code.replace(/[- ]/g, '').toUpperCase() : '';
    if (normalized.length !== 8) throw new HTTPError(422, 'Enter the eight-character code from your terminal.');
    const key = await digest(normalized);
    const sql = 'WHERE code_hash=? AND expires_at>? AND approved_by IS NULL';
    const row = path.endsWith('/review')
      ? await env.DB.prepare("SELECT name, scope FROM cli_requests " + sql).bind(key, Date.now()).first<{name: string; scope: string}>()
      : await env.DB.prepare('UPDATE cli_requests SET approved_by=? ' + sql + ' RETURNING name, scope').bind(user, key, Date.now()).first<{name: string; scope: string}>();
    if (!row) throw new HTTPError(404, 'Code expired or already used.');
    return json(row.scope === 'finance' ? row : { name: row.name });
  }
  throw new HTTPError(404, 'Not found.');
}
