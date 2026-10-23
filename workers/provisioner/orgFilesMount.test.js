const assert = require("node:assert/strict");
const test = require("node:test");

const { orgFilesBind, ORG_FILES_MOUNT } = require("./backends/orgFilesMount.ts");

const ORG = "0d000000-0000-4000-8000-000000000001";
const ROOT = "/var/lib/gcap/org-files";

test("a team organization's folder is bound read-only into the workspace", () => {
  assert.equal(orgFilesBind(ORG, ROOT), `${ROOT}/${ORG}:${ORG_FILES_MOUNT}:ro`);
  assert.ok(ORG_FILES_MOUNT.startsWith("/opt/data/workspace/"));
});

test("no bind unless the operator named a safe host root and the id is an organization UUID", () => {
  assert.equal(orgFilesBind(ORG, ""), null);
  assert.equal(orgFilesBind(ORG, undefined), null);
  assert.equal(orgFilesBind(ORG, "relative/path"), null);
  assert.equal(orgFilesBind(ORG, "/data:/etc"), null);
  assert.equal(orgFilesBind(ORG, "/data/../etc"), null);
  assert.equal(orgFilesBind(null, ROOT), null);
  assert.equal(orgFilesBind("../../etc", ROOT), null);
  assert.equal(orgFilesBind(`${ORG}/../x`, ROOT), null);
});
