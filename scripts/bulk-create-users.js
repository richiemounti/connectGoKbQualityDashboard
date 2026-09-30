#!/usr/bin/env node
/**
 * Create several dashboard users at once from scripts/users.json.
 *
 *   npm run bulk-create-users              (uses scripts/users.json)
 *   npm run bulk-create-users -- other.json
 *
 * users.json is a list of { "email", "name", "roles": [...] }.
 *
 * - New users get a random temporary password, printed once at the end.
 *   Send each person theirs privately — it is not stored anywhere readable.
 * - Existing users keep their password; any roles in the file are added to
 *   the roles they already have (roles are never removed here — use
 *   `npm run create-user -- --email x --revoke <role>` for that).
 *
 * So the same file can be re-run safely, and running it with a new role
 * (e.g. "governance") grants that dashboard to people who already exist.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { MongoClient } = require('mongodb');
const { hashPassword } = require('./create-user');

// 18 random bytes → 24 url-safe characters; no ambiguous padding.
const tempPassword = () => randomBytes(18).toString('base64url');

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, 'users.json'));
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || !list.length) throw new Error(`${file} should be a non-empty JSON array`);
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (check .env)');

  const people = list.map(({ email, name, roles }) => {
    const clean = String(email || '').trim().toLowerCase();
    if (!clean.includes('@')) throw new Error(`Invalid email: ${JSON.stringify(email)}`);
    return {
      email: clean,
      name: name ? String(name).trim() : null,
      roles: (roles || []).map(role => String(role).trim().toLowerCase()).filter(Boolean),
    };
  });

  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 7000 });
  await client.connect();
  const created = [];
  try {
    const users = client.db(process.env.MONGODB_DB || 'connectgo').collection('users');
    await users.createIndex({ email: 1 }, { unique: true });

    for (const person of people) {
      const existing = await users.findOne({ email: person.email });
      if (existing) {
        await users.updateOne({ email: person.email }, {
          $addToSet: { roles: { $each: person.roles } },
          $set: { updated_at: new Date() },
        });
        console.log(`exists   ${person.email} · added roles: ${person.roles.join(', ')}`);
        continue;
      }
      const password = tempPassword();
      await users.insertOne({
        ...person,
        password_hash: await hashPassword(password),
        active: true,
        failed_attempts: 0,
        created_at: new Date(),
      });
      created.push({ ...person, password });
      console.log(`created  ${person.email} · roles: ${person.roles.join(', ')}`);
    }
  } finally {
    await client.close();
  }

  if (created.length) {
    console.log('\nTemporary passwords (shown once — send each privately):\n');
    for (const { email, password } of created) console.log(`  ${email.padEnd(36)} ${password}`);
    console.log('');
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
