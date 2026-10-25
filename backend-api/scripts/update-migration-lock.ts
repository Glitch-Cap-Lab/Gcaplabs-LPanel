// @ts-nocheck
// Appends newly added migration files to migrations.lock.json. Entries already
// in the lock are never rewritten: an edited, renamed or reordered migration
// makes this script fail instead of re-locking it.
const fs = require("node:fs");
const path = require("node:path");
const {
  LOCK_FILE,
  MIGRATIONS_DIR,
  readLock,
  readMigrationFiles,
  verifyMigrationLock,
} = require("../lib/migrationFiles");

const migrations = readMigrationFiles();
const lock = readLock();
const problems = verifyMigrationLock(migrations, lock).filter(
  (problem) => !problem.includes(`is not in ${LOCK_FILE}`),
);
if (problems.length) {
  console.error(`Refusing to update the lock:\n${problems.join("\n")}`);
  process.exit(1);
}
const added = migrations.slice(lock.length);
const next = lock.concat(
  added.map(({ version, file, checksum }) => ({ version, file, checksum })),
);
fs.writeFileSync(path.join(MIGRATIONS_DIR, LOCK_FILE), `${JSON.stringify(next, null, 2)}\n`);
console.log(added.length ? `Locked ${added.map((m) => m.file).join(", ")}` : "Lock already current");
