const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const VALID_KEY = "ab".repeat(32);

function run(env, body) {
  const base = { PATH: process.env.PATH, NODE_OPTIONS: "--import tsx" };
  return spawnSync(process.execPath, ["-e", body], {
    cwd: __dirname,
    env: { ...base, ...env },
    encoding: "utf8",
  });
}

const start = `require("./crypto").assertEncryptionConfiguredForStart(); console.log("started")`;
const store = `console.log(require("./crypto").encrypt("tok"))`;

test("production without a key exits 1", () => {
  const r = run({ NODE_ENV: "production" }, start);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL: ENCRYPTION_KEY/);
});

test("production with a valid key starts", () => {
  const r = run({ NODE_ENV: "production", ENCRYPTION_KEY: VALID_KEY }, start);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /started/);
});

test("production with an invalid key exits 1", () => {
  assert.equal(run({ NODE_ENV: "production", ENCRYPTION_KEY: "short" }, start).status, 1);
});

test("explicit plaintext override lets production start", () => {
  const r = run({ NODE_ENV: "production", NORA_ALLOW_PLAINTEXT_SECRETS: "true" }, start);
  assert.equal(r.status, 0);
});

test("non-production without a key still starts", () => {
  assert.equal(run({ NODE_ENV: "development" }, start).status, 0);
});

test("encrypt refuses to return plaintext in production without a key", () => {
  const r = run({ NODE_ENV: "production" }, store);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to store a secret in plaintext/);
});

test("encrypt output is not plaintext with a valid key", () => {
  const r = run({ NODE_ENV: "production", ENCRYPTION_KEY: VALID_KEY }, store);
  assert.equal(r.status, 0);
  assert.notEqual(r.stdout.trim(), "tok");
});
