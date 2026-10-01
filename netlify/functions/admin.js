// netlify/functions/admin.js
//
// User management for every ConnectGo dashboard. The dashboards share one
// MongoDB users collection, so this one function (deployed on the KB site
// only) manages access to all of them. Admin role required on every call,
// checked against the live user record.
//
//   GET  ?action=list
//   POST ?action=create   { email, name, dashboards: [...], admin }
//   POST ?action=update   { email, name?, dashboards?, admin?, active? }
//   POST ?action=reset    { email }   → new temporary password, shown once
//   POST ?action=unlock   { email }
//   POST ?action=delete   { email }

const { randomBytes } = require('node:crypto');
const { requireUser, unauthorized, sameOrigin, hashPassword, isLockedOut, parseBody, users, json } = require('./auth');

// The dashboards this panel grants. Each matches a site's SITE_KEY. Any other
// roles a user has are left untouched.
const DASHBOARDS = ['kb', 'ops', 'governance'];
const MANAGED = new Set([...DASHBOARDS, 'admin']);

// 18 random bytes → 24 url-safe characters.
const tempPassword = () => randomBytes(18).toString('base64url');
const cleanEmail = value => String(value || '').trim().toLowerCase();

function rolesFrom(body, existing = []) {
  const kept = existing.filter(role => !MANAGED.has(role));
  const dashboards = (Array.isArray(body.dashboards) ? body.dashboards : [])
    .map(role => String(role).toLowerCase())
    .filter(role => DASHBOARDS.includes(role));
  return [...new Set([...(body.admin ? ['admin'] : []), ...dashboards, ...kept])];
}

function publicUser(user) {
  return {
    email: user.email,
    name: user.name || null,
    roles: user.roles || [],
    active: user.active !== false,
    locked: isLockedOut(user),
    last_login_at: user.last_login_at || null,
    created_at: user.created_at || null,
  };
}

async function list(collection, me) {
  const all = await collection.find({}, { projection: { password_hash: 0 } }).sort({ name: 1, email: 1 }).toArray();
  return json(200, { me: me.email, dashboards: DASHBOARDS, users: all.map(publicUser) });
}

async function create(collection, body) {
  const email = cleanEmail(body.email);
  if (!email.includes('@')) return json(400, { error: 'A valid email is required' });
  if (await collection.findOne({ email })) return json(409, { error: `${email} already has an account` });
  const password = tempPassword();
  await collection.insertOne({
    email,
    name: String(body.name || '').trim() || null,
    roles: rolesFrom(body),
    password_hash: await hashPassword(password),
    active: true,
    failed_attempts: 0,
    created_at: new Date(),
  });
  return json(200, { ok: true, email, password });
}

async function update(collection, body, existing, me) {
  const isMe = existing.email === me.email;
  const $set = { updated_at: new Date() };
  if (typeof body.name === 'string') $set.name = body.name.trim() || null;
  if (Array.isArray(body.dashboards) || typeof body.admin === 'boolean') {
    const next = {
      dashboards: Array.isArray(body.dashboards) ? body.dashboards : (existing.roles || []).filter(role => DASHBOARDS.includes(role)),
      admin: typeof body.admin === 'boolean' ? body.admin : (existing.roles || []).includes('admin'),
    };
    if (isMe && !next.admin) return json(400, { error: "You can't remove your own admin access" });
    $set.roles = rolesFrom(next, existing.roles || []);
  }
  if (typeof body.active === 'boolean') {
    if (isMe && !body.active) return json(400, { error: "You can't deactivate your own account" });
    $set.active = body.active;
  }
  await collection.updateOne({ email: existing.email }, { $set });
  return json(200, { ok: true, user: publicUser(await collection.findOne({ email: existing.email })) });
}

async function reset(collection, existing) {
  const password = tempPassword();
  await collection.updateOne({ email: existing.email }, {
    $set: { password_hash: await hashPassword(password), failed_attempts: 0, updated_at: new Date() },
  });
  return json(200, { ok: true, email: existing.email, password });
}

async function unlock(collection, existing) {
  await collection.updateOne({ email: existing.email }, { $set: { failed_attempts: 0, updated_at: new Date() } });
  return json(200, { ok: true });
}

async function remove(collection, existing, me) {
  if (existing.email === me.email) return json(400, { error: "You can't delete your own account" });
  await collection.deleteOne({ email: existing.email });
  return json(200, { ok: true });
}

exports.handler = async event => {
  const action = event.queryStringParameters?.action;
  try {
    const me = await requireUser(event, 'admin');
    if (!me) return unauthorized();
    const collection = await users();

    if (event.httpMethod === 'GET' && action === 'list') return await list(collection, me);
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!sameOrigin(event)) return json(403, { error: 'Cross-site request refused' });

    const body = parseBody(event);
    if (!body) return json(400, { error: 'Expected valid JSON' });
    if (action === 'create') return await create(collection, body);

    const existing = await collection.findOne({ email: cleanEmail(body.email) });
    if (!existing) return json(404, { error: 'No user with that email' });
    if (action === 'update') return await update(collection, body, existing, me);
    if (action === 'reset') return await reset(collection, existing);
    if (action === 'unlock') return await unlock(collection, existing);
    if (action === 'delete') return await remove(collection, existing, me);
    return json(400, { error: 'Unknown action' });
  } catch (error) {
    console.error('Admin request failed:', error.message);
    return json(503, { error: 'User management is temporarily unavailable' });
  }
};
