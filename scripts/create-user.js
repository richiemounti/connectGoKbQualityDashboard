#!/usr/bin/env node
/**
 * Create (or update) a dashboard sign-in user in MongoDB.
 *
 *   npm run create-user -- --email sam@connectgo.co.uk --name "Sam" --roles admin
 *   npm run create-user -- --email kate@connectgo.co.uk --roles kb
 *   npm run create-user -- --email kate@connectgo.co.uk --update      (reset password / roles / name)
 *   npm run create-user -- --email kate@connectgo.co.uk --deactivate  (block sign-in, keep the record)
 *   npm run create-user -- --email kate@connectgo.co.uk --grant governance   (add dashboard roles, no password change)
 *   npm run create-user -- --email kate@connectgo.co.uk --revoke governance  (remove dashboard roles)
 *
 * The password is asked for at the prompt, never passed as an argument, so it
 * stays out of shell history. Reads MONGODB_URI / MONGODB_DB from .env.
 *
 * Hash format must match checkPassword() in netlify/functions/auth.js:
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 */

const { scrypt, randomBytes } = require('node:crypto');
const { promisify } = require('node:util');
const readline = require('node:readline');
const { MongoClient } = require('mongodb');

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD = 12;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key.slice(2)] = true;
    else { args[key.slice(2)] = next; i++; }
  }
  return args;
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), Buffer.from(hash).toString('base64')].join('$');
}

const splitRoles = value => String(value).split(',').map(role => role.trim().toLowerCase()).filter(Boolean);

// Prompt without echoing what is typed.
function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = text => { if (!rl.muted) rl.output.write(text); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    rl.muted = true;
  });
}

async function askPassword() {
  const password = await askHidden('Password: ');
  if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  const confirm = await askHidden('Confirm password: ');
  if (password !== confirm) throw new Error('Passwords do not match');
  return password;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Usage: --email <address> [--name "Full Name"] [--roles kb,admin] [--update | --deactivate | --grant <roles> | --revoke <roles>]');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (check .env)');

  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 7000 });
  await client.connect();
  try {
    const users = client.db(process.env.MONGODB_DB || 'connectgo').collection('users');
    await users.createIndex({ email: 1 }, { unique: true });
    const existing = await users.findOne({ email });

    if (typeof args.grant === 'string' || typeof args.revoke === 'string') {
      if (!existing) throw new Error(`No user with email ${email}`);
      const change = typeof args.grant === 'string'
        ? { $addToSet: { roles: { $each: splitRoles(args.grant) } } }
        : { $pull: { roles: { $in: splitRoles(args.revoke) } } };
      await users.updateOne({ email }, { ...change, $set: { updated_at: new Date() } });
      const updated = await users.findOne({ email });
      console.log(`${email} · roles: ${updated.roles.join(', ') || '(none)'}`);
      return;
    }

    if (args.deactivate) {
      if (!existing) throw new Error(`No user with email ${email}`);
      await users.updateOne({ email }, { $set: { active: false, updated_at: new Date() } });
      console.log(`Deactivated ${email}`);
      return;
    }

    if (existing && !args.update) throw new Error(`${email} already exists — use --update to reset their password/roles`);
    if (!existing && args.update) throw new Error(`No user with email ${email} to update`);

    const roles = typeof args.roles === 'string'
      ? splitRoles(args.roles)
      : existing?.roles || [process.env.SITE_KEY || 'kb'];
    const name = typeof args.name === 'string' ? args.name.trim() : existing?.name || null;
    const password_hash = await hashPassword(await askPassword());

    if (existing) {
      await users.updateOne({ email }, {
        $set: { name, roles, password_hash, active: true, failed_attempts: 0, updated_at: new Date() },
      });
      console.log(`Updated ${email} · roles: ${roles.join(', ')}`);
    } else {
      await users.insertOne({
        email, name, roles, password_hash, active: true, failed_attempts: 0, created_at: new Date(),
      });
      console.log(`Created ${email} · roles: ${roles.join(', ')}`);
    }
  } finally {
    await client.close();
  }
}

module.exports = { hashPassword, splitRoles };

if (require.main === module) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
