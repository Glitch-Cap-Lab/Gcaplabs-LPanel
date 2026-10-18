export {};

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  HEADMASTER_STORAGE_WRITE_PY,
  storageAllocationBytes,
} = require("../../agent-runtime/lib/headmasterStorage");

test.each([undefined, null, true, "10", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])(
  "invalid stored disk_gb %p has no allocation",
  (disk_gb) => {
    expect(storageAllocationBytes({ disk_gb })).toBeNull();
  },
);

test("stored integer GiB is converted to safe integer bytes", () => {
  expect(storageAllocationBytes({ disk_gb: 10 })).toBe(10 * 1024 ** 3);
});

describe("runtime persistent allocation writer", () => {
  let root: string;
  let target: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "headmaster-storage-"));
    target = path.join(root, "config.yaml");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(raw: unknown) {
    return spawnSync("python3", ["-"], {
      input: `${HEADMASTER_STORAGE_WRITE_PY}\nimport json\nresult = write_storage_allocation(${JSON.stringify(root)}, ${JSON.stringify(raw)})\nprint(json.dumps(result))\nprint(json.dumps(yaml.safe_load(Path(${JSON.stringify(target)}).read_text()) if Path(${JSON.stringify(target)}).exists() else {}))`,
      encoding: "utf8",
    });
  }

  test("writes only the root allocation, preserves siblings and leaves profile configuration alone", () => {
    fs.writeFileSync(
      target,
      "model: {default: keep}\nheadmaster: {other: retained, storage: {other: retained}}\n",
    );
    const profile = path.join(root, "profiles", "second");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "config.yaml"), "profile: untouched\n");
    const result = run(String(10 * 1024 ** 3));
    expect(result.status).toBe(0);
    const [receipt, config] = result.stdout
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    expect(receipt).toEqual({ ok: true, mutated: true });
    expect(config).toEqual({
      model: { default: "keep" },
      headmaster: {
        other: "retained",
        storage: { other: "retained", allocation_bytes: 10 * 1024 ** 3 },
      },
    });
    expect(fs.readFileSync(path.join(profile, "config.yaml"), "utf8")).toBe("profile: untouched\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(JSON.parse(run(String(10 * 1024 ** 3)).stdout.split("\n")[0])).toEqual({
      ok: true,
      mutated: false,
    });
  });

  test.each(["", "0", "-1", "true", "10.5", "9007199254740992", "1\n"])(
    "invalid bootstrap %p removes a stale allocation",
    (raw) => {
      fs.writeFileSync(target, "headmaster: {storage: {allocation_bytes: 123, other: retained}}\n");
      const result = run(raw);
      expect(result.status).toBe(0);
      const config = JSON.parse(result.stdout.trim().split("\n")[1]);
      expect(config).toEqual({ headmaster: { storage: { other: "retained" } } });
    },
  );

  test("refuses symlink targets and malformed mappings without touching existing data", () => {
    const outside = path.join(root, "elsewhere.yaml");
    fs.writeFileSync(outside, "keep: me\n");
    fs.symlinkSync(outside, target);
    expect(run("1024").status).not.toBe(0);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep: me\n");
    fs.unlinkSync(target);
    fs.writeFileSync(target, "headmaster: []\n");
    expect(run("1024").status).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("headmaster: []\n");
  });
});
