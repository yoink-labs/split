import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const production = 'https://split-api.yoinklabs.dev';
export function apiOrigin(value) {
  const u = new URL(value);
  const local = ['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !(local && u.protocol === 'http:')) ||
      u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new Error('SPLIT_API_URL must be an HTTPS origin (or HTTP on localhost).');
  }
  return u.origin;
}

export async function client(env = process.env) {
  const file = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'split', 'credentials.json');
  let saved;
  try { saved = JSON.parse(await readFile(file,'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read Split credentials. Check the configuration file.'); }
  const origin = apiOrigin(env.SPLIT_API_URL || (env.SPLIT_TOKEN ? production : saved?.origin) || production);
  const token = env.SPLIT_TOKEN || (saved?.origin === origin ? saved.token : undefined);

  async function request(path, data, authenticated = true, extraHeaders = {}) {
    if (authenticated && !token) throw new Error('Sign in with split login or set SPLIT_TOKEN.');
    // Node fetch can replay a POST after a 421. Send ledger writes exactly once.
    const target = new URL(path, origin);
    const transport = target.protocol === 'https:' ? https : http;
    const response = await new Promise((resolve, reject) => {
      const req = transport.request(target, {
        method: data === undefined ? 'GET' : 'POST', agent: false, signal: AbortSignal.timeout(30000),
        headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(authenticated ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders }
      }, resolve);
      req.on('error', reject);
      req.end(data === undefined ? undefined : JSON.stringify(data));
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString('utf8');
    const status = response.statusCode;
    let result;
    try { result = value ? JSON.parse(value) : undefined; }
    catch { throw new Error('Split returned an unexpected response (HTTP ' + status + ').'); }
    if (status < 200 || status >= 300) {
      const error = new Error(typeof result?.error === 'string' ? result.error : 'Split request failed (HTTP ' + status + ').');
      error.status = status;
      throw error;
    }
    return result;
  }

  async function save(token) {
    if (typeof token !== 'string' || !token.startsWith('spl_')) throw new Error('Split returned an invalid device credential.');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID();
    try {
      await writeFile(temp, JSON.stringify({ origin, token }) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async function forget() {
    if (saved?.origin !== origin || saved?.token !== token) return;
    // Another login may have replaced this credential while revocation was in flight.
    const current = JSON.parse(await readFile(file,'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e; }));
    if (current.token === token && current.origin === origin) await unlink(file);
  }
  return { origin, signedIn: Boolean(token), request, save, forget };
}
