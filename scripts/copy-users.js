#!/usr/bin/env node
/**
 * One-off: copy the dashboard `users` collection from the old cluster to the
 * new one, keeping password hashes so everyone's current password still works.
 *
 *   npm run copy-users
 *
 * - Destination is MONGODB_URI / MONGODB_DB from .env (the new cluster).
 * - The OLD cluster's connection string is asked for at a hidden prompt, so it
 *   never lands in a file or shell history.
 * - Upserts by email: safe to re-run, never creates duplicates.
 * - Never deletes anything from the old cluster — do that yourself once the
 *   dashboards are confirmed working.
 */

const readline = require('node:readline');
const { MongoClient } = require('mongodb');

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = text => { if (!rl.muted) rl.output.write(text); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
    rl.muted = true;
  });
}

// mongodb+srv://user:pass@host/... → host, for safe logging.
const hostOf = uri => (uri.match(/@([^/?]+)/) || [])[1] || '(unknown host)';
const stripQuotes = value => value.replace(/^['"]|['"]$/g, '');

async function main() {
  const dbName = process.env.MONGODB_DB || 'connectgo';
  const newUri = stripQuotes(process.env.MONGODB_URI || '');
  if (!newUri) throw new Error('MONGODB_URI (new cluster) is not set in .env');

  const oldUri = stripQuotes(await askHidden('OLD cluster connection string: '));
  if (!oldUri.startsWith('mongodb')) throw new Error('That does not look like a MongoDB connection string');
  if (hostOf(oldUri) === hostOf(newUri)) throw new Error('Old and new connection strings point at the same cluster');

  const source = new MongoClient(oldUri, { serverSelectionTimeoutMS: 10000 });
  const target = new MongoClient(newUri, { serverSelectionTimeoutMS: 10000 });
  await Promise.all([source.connect(), target.connect()]);

  try {
    console.log(`From ${hostOf(oldUri)} → to ${hostOf(newUri)} (db: ${dbName})`);
    const users = await source.db(dbName).collection('users').find({}).toArray();
    if (!users.length) throw new Error(`No users found in ${dbName}.users on the old cluster`);

    const destination = target.db(dbName).collection('users');
    await destination.createIndex({ email: 1 }, { unique: true });

    const result = await destination.bulkWrite(users.map(user => ({
      replaceOne: { filter: { email: user.email }, replacement: user, upsert: true },
    })));

    console.log(`Copied ${users.length} users (${result.upsertedCount} new, ${result.modifiedCount} updated):`);
    for (const { email, roles } of users) console.log(`  ${email} · ${(roles || []).join(', ')}`);
    console.log(`New cluster now has ${await destination.countDocuments()} users.`);
  } finally {
    await Promise.all([source.close(), target.close()]);
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
