// 账号与登录：密码散列（scrypt）、会话令牌、Cookie 读写。零依赖（node:crypto）。
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { get, run } from './db.mjs';

export const SESSION_COOKIE = 'nv_session';
const SESSION_DAYS = 30;

/* ---------------- 密码 ---------------- */

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const h = scryptSync(String(password), String(salt || ''), 64);
  const t = Buffer.from(String(hash || ''), 'hex');
  return h.length === t.length && h.length > 0 && timingSafeEqual(h, t);
}

/* ---------------- 会话 ---------------- */

function sqlNow(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)', token, userId, sqlNow(SESSION_DAYS));
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const row = get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
    token,
  );
  return row || null;
}

export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token=?', token);
}

/* ---------------- Cookie ---------------- */

export function parseCookies(req) {
  const out = {};
  const header = req.headers?.cookie || '';
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || '';
}

export function sessionCookie(token, { clear = false } = {}) {
  const base = `Path=/; HttpOnly; SameSite=Lax`;
  return clear ? `${SESSION_COOKIE}=; ${base}; Max-Age=0` : `${SESSION_COOKIE}=${token}; ${base}; Max-Age=${SESSION_DAYS * 86400}`;
}

/* ---------------- 注册 / 登录 ---------------- */

function normalizeUsername(username) {
  return String(username || '').trim();
}

function validate(username, password) {
  if (!/^[\w\u4e00-\u9fa5.-]{2,20}$/.test(username)) return '用户名需 2-20 位（中文/字母/数字/下划线）';
  if (String(password || '').length < 6) return '密码至少 6 位';
  return '';
}

export function registerUser({ username, password, name } = {}) {
  username = String(username || '').trim();
  const err = validate(username, password);
  if (err) return { ok: false, error: err };
  if (get('SELECT 1 AS x FROM users WHERE username=?', username)) return { ok: false, error: '该用户名已被注册' };
  const { salt, hash } = hashPassword(password);
  const id = 'acct-' + randomBytes(9).toString('hex');
  run(
    `INSERT INTO users(id, name, username, password_hash, salt, is_account, created_at, updated_at)
     VALUES(?,?,?,?,?,1,datetime('now'),datetime('now'))`,
    id,
    String(name || '').trim() || username,
    username,
    hash,
    salt,
  );
  return { ok: true, user: get('SELECT * FROM users WHERE id=?', id) };
}

export function loginUser({ username, password } = {}) {
  username = String(username || '').trim();
  const u = get('SELECT * FROM users WHERE username=?', username);
  if (!u || !u.is_account || !u.password_hash) return { ok: false, error: '用户名或密码错误' };
  if (!verifyPassword(password, u.salt, u.password_hash)) return { ok: false, error: '用户名或密码错误' };
  return { ok: true, user: u };
}

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username || '', name: u.name || '书友', isAccount: !!u.is_account };
}
