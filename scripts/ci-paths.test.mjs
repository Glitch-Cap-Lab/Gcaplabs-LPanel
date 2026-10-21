import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./ci-paths.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "headmaster-ci-paths-"));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  t.after(() => {
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + "/") ||
        resolve(root).startsWith(resolve(tmpdir()) + "\\"),
    );
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "ci-fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(root, "no-hooks"));
  const write = (path, text = "fixture\n") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  write("backend-api/existing.ts");
  write("admin-dashboard/existing.ts");
  write("services/headmaster-inference/existing.mjs");
  commit();
  git("checkout", "--quiet", "-b", "fixture-pr");
  return {
    cwd,
    git,
    write,
    commit,
    remove: (path) => rmSync(join(cwd, path)),
    rename: (from, to) => {
      mkdirSync(dirname(join(cwd, to)), { recursive: true });
      renameSync(join(cwd, from), join(cwd, to));
    },
    merge(action = "opened") {
      const head = git("rev-parse", "fixture-pr");
      git("checkout", "--quiet", "main");
      const base = git("rev-parse", "HEAD");
      git("merge", "--quiet", "--no-ff", "--no-edit", "fixture-pr");
      const event = {
        action,
        number: 7,
        pull_request: {
          number: 7,
          draft: false,
          base: { sha: base, ref: "main", repo: { full_name: "fixture/repo" } },
          head: { sha: head, ref: "fixture-pr" },
        },
      };
      const env = {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: join(root, "event.json"),
        GITHUB_SHA: git("rev-parse", "HEAD"),
        GITHUB_REF: "refs/pull/7/merge",
        GITHUB_BASE_REF: "main",
        GITHUB_HEAD_REF: "fixture-pr",
        GITHUB_REPOSITORY: "fixture/repo",
        GITHUB_OUTPUT: join(root, "output"),
      };
      return {
        event,
        env,
        run(lane) {
          writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
          writeFileSync(env.GITHUB_OUTPUT, "");
          const result = spawnSync(process.execPath, [script, lane], {
            cwd,
            env,
            encoding: "utf8",
          });
          return { ...result, output: readFileSync(env.GITHUB_OUTPUT, "utf8") };
        },
      };
    },
  };
}

for (const [path, expected] of [
  ["backend-api/change.ts", [true, false, false]],
  ["workers/provisioner/change.ts", [true, false, false]],
  ["agent-runtime/change.ts", [true, false, false]],
  ["admin-dashboard/change.ts", [false, true, false]],
  ["services/headmaster-inference/change.mjs", [false, false, true]],
  ["backend-api/db.ts", [true, false, true]],
  [".nvmrc", [true, true, true]],
  ["tsconfig.base.json", [true, true, true]],
  ["scripts/ci-paths.mjs", [true, true, true]],
  ["scripts/ci-paths.test.mjs", [true, true, true]],
  [".github/workflows/backend.yml", [true, false, false]],
  [".github/workflows/admin-dashboard.yml", [false, true, false]],
  [".github/workflows/inference-relay.yml", [false, false, true]],
  ["docs/unrelated file.md", [false, false, false]],
]) {
  test(`complete Git diff selects lanes for ${path}`, (t) => {
    const repo = fixture(t);
    repo.write(path);
    repo.commit();
    const pr = repo.merge();
    ["backend", "admin", "relay"].forEach((lane, index) => {
      const result = pr.run(lane);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output, `affected=${expected[index]}\n`);
    });
  });
}

for (const [from, to, lane] of [
  ["backend-api/existing.ts", "docs/moved.ts", "backend"],
  ["admin-dashboard/existing.ts", "backend-api/moved.ts", "admin"],
  ["services/headmaster-inference/existing.mjs", "docs/moved.mjs", "relay"],
]) {
  test(`renamed ${from} still requires its original lane`, (t) => {
    const repo = fixture(t);
    repo.rename(from, to);
    repo.commit();
    const pr = repo.merge();
    const result = pr.run(lane);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "affected=true\n");
    if (to.startsWith("backend-api/")) {
      const destination = pr.run("backend");
      assert.equal(destination.status, 0, destination.stderr);
      assert.equal(destination.output, "affected=true\n");
    }
  });
}

test("deleted component paths still require both selected lanes", (t) => {
  const repo = fixture(t);
  repo.remove("services/headmaster-inference/existing.mjs");
  repo.remove("backend-api/existing.ts");
  repo.commit();
  const pr = repo.merge();
  for (const lane of ["backend", "relay"]) {
    const result = pr.run(lane);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "affected=true\n");
  }
});

test("synchronize reevaluates the new head instead of retaining an unrelated decision", (t) => {
  const repo = fixture(t);
  repo.write("docs/first.md");
  repo.commit();
  assert.equal(repo.merge().run("backend").output, "affected=false\n");
  repo.git("checkout", "--quiet", "fixture-pr");
  repo.write("backend-api/new-head.ts");
  repo.commit();
  const result = repo.merge("synchronize").run("backend");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "affected=true\n");
});

test("base-only changes are excluded from the PR diff", (t) => {
  const repo = fixture(t);
  repo.write("docs/pr-only.md");
  repo.commit();
  repo.git("checkout", "--quiet", "main");
  repo.write("backend-api/base-only.ts");
  repo.commit();
  const result = repo.merge().run("backend");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "affected=false\n");
});

for (const [name, mutate] of [
  [
    "missing head",
    (pr) => {
      delete pr.event.pull_request.head;
    },
  ],
  [
    "missing base",
    (pr) => {
      delete pr.event.pull_request.base;
    },
  ],
  [
    "non-SHA ref",
    (pr) => {
      pr.event.pull_request.head.sha = "main";
    },
  ],
  [
    "unavailable commit",
    (pr) => {
      pr.event.pull_request.head.sha = "1".repeat(40);
    },
  ],
  [
    "wrong base ref",
    (pr) => {
      pr.env.GITHUB_BASE_REF = "other";
    },
  ],
  [
    "wrong head ref",
    (pr) => {
      pr.env.GITHUB_HEAD_REF = "other";
    },
  ],
  [
    "wrong repository",
    (pr) => {
      pr.env.GITHUB_REPOSITORY = "other/repo";
    },
  ],
  [
    "wrong checkout",
    (pr) => {
      pr.env.GITHUB_SHA = pr.event.pull_request.base.sha;
    },
  ],
  [
    "wrong event",
    (pr) => {
      pr.env.GITHUB_EVENT_NAME = "pull_request_target";
    },
  ],
  [
    "foreign commit not in checkout",
    (pr, repo) => {
      pr.event.pull_request.head.sha = repo.git(
        "commit-tree",
        `${pr.event.pull_request.base.sha}^{tree}`,
        "-m",
        "orphan fixture",
      );
    },
  ],
  [
    "diff failure",
    (pr, repo) => {
      repo.git("config", "diff.algorithm", "invalid-fixture-algorithm");
    },
  ],
]) {
  test(`${name} fails without emitting a false skip`, (t) => {
    const repo = fixture(t);
    repo.write("docs/only.md");
    repo.commit();
    const pr = repo.merge();
    mutate(pr, repo);
    const result = pr.run("backend");
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.match(result.stderr, /required checks cannot be skipped/);
  });
}

test("manual dispatch always runs the chosen lane without needing a PR diff", (t) => {
  const repo = fixture(t);
  repo.write("docs/only.md");
  repo.commit();
  const pr = repo.merge();
  pr.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  delete pr.event.pull_request;
  for (const lane of ["backend", "admin", "relay"]) {
    const result = pr.run(lane);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "affected=true\n");
  }
});

test("crisscross history fails closed instead of choosing an arbitrary merge base", (t) => {
  const repo = fixture(t);
  repo.write("docs/only.md");
  repo.commit();
  const pr = repo.merge();
  const original = pr.event.pull_request.base.sha;
  const a = pr.event.pull_request.head.sha;
  const b = repo.git("commit-tree", `${original}^{tree}`, "-p", original, "-m", "other side");
  const left = repo.git("commit-tree", `${a}^{tree}`, "-p", a, "-p", b, "-m", "left merge");
  const right = repo.git("commit-tree", `${b}^{tree}`, "-p", b, "-p", a, "-m", "right merge");
  const checkout = repo.git(
    "commit-tree",
    `${left}^{tree}`,
    "-p",
    left,
    "-p",
    right,
    "-m",
    "checkout merge",
  );
  repo.git("checkout", "--quiet", "--detach", checkout);
  assert.equal(repo.git("merge-base", "--all", left, right).split("\n").length, 2);
  pr.event.pull_request.base.sha = left;
  pr.event.pull_request.head.sha = right;
  pr.env.GITHUB_SHA = checkout;
  const result = pr.run("backend");
  assert.equal(result.status, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /required checks cannot be skipped/);
});
