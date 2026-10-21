import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Keep the required job present on every PR. Only its expensive steps depend on
// this result; incomplete event/history/diff data must fail the job, never skip it.
const lanes = {
  backend: ["backend-api/", "workers/provisioner/", "agent-runtime/"],
  admin: ["admin-dashboard/"],
  relay: ["services/headmaster-inference/"],
};
const workflowFiles = {
  backend: ".github/workflows/backend.yml",
  admin: ".github/workflows/admin-dashboard.yml",
  relay: ".github/workflows/inference-relay.yml",
};
const relayFiles = new Set([
  "backend-api/llmProviders.ts",
  "backend-api/db.ts",
  "backend-api/crypto.ts",
  "backend-api/demoLlm.ts",
  "backend-api/lib/advisoryLocks.ts",
  "backend-api/lib/connectionConfig.ts",
  "agent-runtime/lib/nemoclawDefaults.ts",
  "agent-runtime/lib/hermesRuntimeBootstrap.ts",
  "agent-runtime/lib/headmasterInference.ts",
  "agent-runtime/lib/headmasterStorage.ts",
]);
const sharedFiles = new Set([
  ".nvmrc",
  "tsconfig.base.json",
  "scripts/ci-paths.mjs",
  "scripts/ci-paths.test.mjs",
]);

/** @param {string[]} args @param {string} cwd @returns {Buffer} */
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Cannot validate the complete PR diff");
  }
}

/** @param {unknown} value @returns {string} */
function requireSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value) || /^0+$/.test(value)) {
    throw new Error("Missing or invalid PR commit metadata");
  }
  return value;
}

/** @param {unknown} lane @param {NodeJS.ProcessEnv} env @param {string} cwd */
export function affected(lane, env = process.env, cwd = process.cwd()) {
  if (typeof lane !== "string" || !Object.hasOwn(lanes, lane)) throw new Error("Unknown CI lane");
  const laneKey = /** @type {keyof typeof lanes} */ (lane);
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") return true;
  if (env.GITHUB_EVENT_NAME !== "pull_request") throw new Error("Unsupported CI event");
  if (!env.GITHUB_EVENT_PATH) throw new Error("Missing PR event file");

  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  const base = requireSha(pr?.base?.sha);
  const head = requireSha(pr?.head?.sha);
  const checkout = requireSha(env.GITHUB_SHA);
  if (
    !Number.isSafeInteger(event.number) ||
    event.number < 1 ||
    pr.number !== event.number ||
    !pr.base.ref ||
    !pr.head.ref ||
    pr.base.ref !== env.GITHUB_BASE_REF ||
    pr.head.ref !== env.GITHUB_HEAD_REF ||
    !env.GITHUB_REPOSITORY ||
    pr.base.repo?.full_name !== env.GITHUB_REPOSITORY ||
    env.GITHUB_REF !== `refs/pull/${event.number}/merge`
  ) {
    throw new Error("Missing or inconsistent PR event metadata");
  }
  for (const sha of [base, head, checkout]) {
    if (
      git(["rev-parse", "--verify", `${sha}^{commit}`], cwd)
        .toString()
        .trim() !== sha
    ) {
      throw new Error("PR commit metadata does not resolve exactly");
    }
  }
  if (git(["rev-parse", "HEAD"], cwd).toString().trim() !== checkout) {
    throw new Error("Checkout does not match the PR event");
  }
  git(["merge-base", "--is-ancestor", base, checkout], cwd);
  git(["merge-base", "--is-ancestor", head, checkout], cwd);
  const mergeBases = git(["merge-base", "--all", base, head], cwd).toString().trim().split("\n");
  if (mergeBases.length !== 1) throw new Error("Ambiguous PR merge base");
  const mergeBase = requireSha(mergeBases[0]);

  // Compare from the unique merge base (the PR's three-dot semantics), excluding
  // changes made only on base. Multiple merge bases cannot prove an unrelated diff.
  // Disabling renames includes both the deleted source and added destination.
  const output = git(
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      mergeBase,
      head,
      "--",
    ],
    cwd,
  );
  if (output.length && output.at(-1) !== 0) throw new Error("Incomplete PR diff output");
  const paths = new TextDecoder("utf-8", { fatal: true })
    .decode(output)
    .split("\0")
    .filter(Boolean);
  return paths.some(
    (path) =>
      sharedFiles.has(path) ||
      path === workflowFiles[laneKey] ||
      lanes[laneKey].some((prefix) => path.startsWith(prefix)) ||
      (laneKey === "relay" && relayFiles.has(path)),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = affected(process.argv[2]);
    if (!process.env.GITHUB_OUTPUT) throw new Error("Missing workflow output file");
    appendFileSync(process.env.GITHUB_OUTPUT, `affected=${result}\n`);
    console.log(
      result ? "Relevant changes: run lane checks" : "Complete diff is unrelated to this lane",
    );
  } catch {
    console.error("CI path selection failed; required checks cannot be skipped");
    process.exitCode = 1;
  }
}
