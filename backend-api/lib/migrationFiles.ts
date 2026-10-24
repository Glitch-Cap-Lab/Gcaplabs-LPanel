// @ts-nocheck
// Numbered schema migrations on disk (backend-api/migrations/NNNN_name.sql) and
// the lock that pins them. The runner records version = position, so a file may
// never be inserted, renamed, reordered or edited once it is in the lock; new
// migrations take the next number and are added to the lock in the same change.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const LOCK_FILE = "migrations.lock.json";
const FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9-]*)\.sql$/;

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

/** Reads and validates the numbered files: strictly 0001..N, no gaps or duplicates. */
function readMigrationFiles(dir = MIGRATIONS_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  return files.map((file, index) => {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new Error(`Migration file ${file} must be named NNNN_name.sql (lowercase, hyphens)`);
    }
    const version = Number(match[1]);
    if (version !== index + 1) {
      throw new Error(
        `Migration file ${file} has number ${version} but position ${index + 1}: numbers must run 0001..N without gaps or duplicates`,
      );
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    return { version, file, name: match[2], sql, checksum: checksum(sql) };
  });
}

function readLock(dir = MIGRATIONS_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), "utf8"));
}

/** Returns a list of problems; empty means the files match the lock and only append to it. */
function verifyMigrationLock(migrations, lock) {
  const problems = [];
  lock.forEach((locked, index) => {
    const current = migrations[index];
    if (!current) {
      problems.push(`Locked migration ${locked.file} is missing`);
    } else if (current.file !== locked.file) {
      problems.push(
        `Position ${index + 1} is ${current.file} but the lock has ${locked.file}: migrations were inserted, renamed or reordered`,
      );
    } else if (current.checksum !== locked.checksum) {
      problems.push(`${locked.file} was edited after it was locked; add a new migration instead`);
    }
  });
  migrations.slice(lock.length).forEach((migration) => {
    problems.push(
      `${migration.file} is not in ${LOCK_FILE}; run "npm run migrations:lock" in backend-api and commit the result`,
    );
  });
  return problems;
}

/** Migrations for the runner; refuses to start when the files disagree with the lock. */
function loadMigrationFiles(dir = MIGRATIONS_DIR) {
  const migrations = readMigrationFiles(dir);
  const problems = verifyMigrationLock(migrations, readLock(dir));
  if (problems.length) throw new Error(`Migration lock check failed:\n${problems.join("\n")}`);
  return migrations.map(({ name, sql }) => ({ name, sql }));
}

module.exports = {
  LOCK_FILE,
  MIGRATIONS_DIR,
  loadMigrationFiles,
  readLock,
  readMigrationFiles,
  verifyMigrationLock,
};
