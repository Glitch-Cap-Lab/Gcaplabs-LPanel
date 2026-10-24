// @ts-nocheck

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadMigrationFiles,
  readLock,
  readMigrationFiles,
  verifyMigrationLock,
} = require("../lib/migrationFiles");
const { normalizeMigrations } = require("../lib/migrationRunner");

function entry(version, file, sql) {
  return { version, file, checksum: require("crypto").createHash("sha256").update(sql).digest("hex"), sql };
}

describe("migration files and lock", () => {
  it("matches the committed lock (fails on reorder, mid-list insert, edit or unlocked file)", () => {
    expect(verifyMigrationLock(readMigrationFiles(), readLock())).toEqual([]);
    expect(() => loadMigrationFiles()).not.toThrow();
  });

  it("feeds the runner in file order so versions equal file numbers", () => {
    const files = readMigrationFiles();
    const normalized = normalizeMigrations(loadMigrationFiles());
    expect(normalized.map((m) => m.version)).toEqual(files.map((f) => f.version));
    expect(normalized.map((m) => m.checksum)).toEqual(files.map((f) => f.checksum));
  });

  const a = entry(1, "0001_a.sql", "SELECT 1");
  const b = entry(2, "0002_b.sql", "SELECT 2");
  const c = entry(3, "0003_c.sql", "SELECT 3");
  const lock = [a, b].map(({ version, file, checksum }) => ({ version, file, checksum }));

  it("accepts a new migration only as an unlocked append", () => {
    expect(verifyMigrationLock([a, b], lock)).toEqual([]);
    expect(verifyMigrationLock([a, b, c], lock)).toEqual([
      expect.stringMatching(/0003_c\.sql is not in migrations\.lock\.json/),
    ]);
  });

  it("rejects reordered migrations", () => {
    const problems = verifyMigrationLock(
      [{ ...b, version: 1, file: "0001_b.sql" }, { ...a, version: 2, file: "0002_a.sql" }],
      lock,
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/inserted, renamed or reordered/);
  });

  it("rejects a mid-list insert that shifts later migrations", () => {
    const inserted = entry(2, "0002_new.sql", "SELECT 9");
    const shifted = { ...b, version: 3, file: "0003_b.sql" };
    expect(verifyMigrationLock([a, inserted, shifted], lock)[0]).toMatch(
      /inserted, renamed or reordered/,
    );
  });

  it("rejects an edit to a locked migration and a deleted one", () => {
    expect(verifyMigrationLock([a, { ...b, checksum: "x" }], lock)[0]).toMatch(/edited after/);
    expect(verifyMigrationLock([a], lock)[0]).toMatch(/is missing/);
  });

  it("rejects gaps, duplicate numbers and bad names on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-"));
    fs.writeFileSync(path.join(dir, "0001_a.sql"), "SELECT 1");
    fs.writeFileSync(path.join(dir, "0003_c.sql"), "SELECT 3");
    expect(() => readMigrationFiles(dir)).toThrow(/without gaps or duplicates/);
    fs.rmSync(path.join(dir, "0003_c.sql"));
    fs.writeFileSync(path.join(dir, "0001_dup.sql"), "SELECT 1");
    expect(() => readMigrationFiles(dir)).toThrow(/without gaps or duplicates/);
    fs.rmSync(path.join(dir, "0001_dup.sql"));
    fs.writeFileSync(path.join(dir, "0002_Bad Name.sql"), "SELECT 2");
    expect(() => readMigrationFiles(dir)).toThrow(/must be named/);
  });
});
