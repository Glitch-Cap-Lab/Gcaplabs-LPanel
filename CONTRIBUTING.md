# Contributing to LPanel

LPanel is the Headmaster control plane (see the README). It is derived from an open-source platform that keeps its name in internal identifiers and licence notices only.

This is the fix workflow for the Headmaster repositories. The full rule set is Part 5 of `audits/2026-10-05-full-product-audit/REPORT.md` in `gcaplabs-desktop`; this file is the part you need here.

## 1. One worktree per fix

Everything runs off `main`. There are no alpha or beta branches. Give each fix its own worktree and branch so work in progress never collides, and never use `git stash`.

```sh
git fetch origin main
git worktree add ../Gcaplabs-LPanel-<fix> -b <area>/<short-name> origin/main
cd ../Gcaplabs-LPanel-<fix>
# ... make the change, commit ...
git push -u origin <area>/<short-name>
# after the merge:
cd - && git worktree remove ../Gcaplabs-LPanel-<fix>
```

One pull request per fix, kept small enough to review in one sitting. Do not stack pull requests unless one truly needs the other, and say so in the body.

## 2. Upstream first

Before building anything, check how the platform LPanel is derived from, and Core's upstream, already do it, then port or adapt that in our design. No pull requests to upstream.


## 3. The brand gate

Nothing a customer or the bot can see says Hermes, Nous or Nora: UI text, bot replies and identity, errors, prompts, tool results, installers, the site, the iOS app, anything printed under the `headmaster` and `hm` commands. The product is Headmaster, the control plane is LPanel. Internal names stay as they are: paths such as `~/.hermes`, environment variable names, module, package, container and image names, wire header names, and the real `hermes` binary. Fix visible text, not plumbing.

Every visible string in `admin-dashboard`, `frontend-dashboard` and `frontend-marketing` says LPanel or Headmaster control plane, never the old project name, and never Hermes or Nous. Keep internal identifiers (container, network and database names, API key prefixes, package names, file paths) and the licence notices as they are: change strings, not ids. Check your diff for new hits:

```sh
git diff origin/main -U0 | grep -i -E '^\+.*\b(nora|hermes|nous)\b'
node --test scripts/headmaster/branding.test.mjs
```

This repository has no pre-push hook yet; run the checks by hand, or install the desktop repository's installer with `--all` to cover the siblings that have one.


## 4. Tests

Run the tests and lint for exactly what you changed, and paste the result in the pull request. Backend, admin-dashboard and inference-relay workflows select relevant ready PR changes and run on each new head. Dashboard/marketing tests remain label/manual-only in `full-ci.yml`. A workflow definition is not a passing hosted check: verify the accepted head's result separately, including any runner or billing restriction.

Each of the three normal workflows emits its existing check name on every ready PR. `scripts/ci-paths.mjs` compares the complete event base/head Git history inside the job; unrelated changes skip component commands, while missing metadata/history or a failed diff fails the check. Renames include both paths, and deleted paths still select their component. Manual runs always execute that workflow's component checks; drafts retain the job-level skip until marked ready. Run `node --test scripts/ci-paths.test.mjs` when changing this selection.

`cd backend-api && npx jest path/to/file` for API changes; `cd admin-dashboard && npm run test:helpers && npm run typecheck` for the admin screens (the Remote Hosts copy lives in `lib/remoteHostTranslations.ts` and every key must exist in every non-English locale); `cd services/headmaster-inference && npm test` for the deterministic relay suite; `cd frontend-marketing && npm test`; `npm run contributor:check` to run the checks for the subsystems you changed.

Re-read your own diff before you push. Ask what would make a reviewer or a test reject it.

## 5. The pull request

Open it as a draft, finish it, then merge it yourself. Merge everything that is finished; leave a pull request unmerged only while it is still being changed or when it would break `main`, and say why in one line. `agent-runtime/` and `workers/provisioner/backends/` are shared by `backend-api` and the worker: verify both consumers before you merge a change there. Update the nearest documentation in the same pull request when behaviour, routes or architecture change.

Pull request body, in this order:

```md
**Before:** what a person sees or what breaks today, in plain words.

**After:** what they see after this change.

**How:** a short paragraph: what the change does and why this way.

**Tests run:** the commands and their results.

**Owner decisions:** anything you did not decide, with the options. "None" if none.
```

No tracking labels in the opening lines, and never paste a secret, token, SSH user or server address into a body, comment or file.

## 6. What waits for the owner

- Deploys, SSH, live settings and database changes: only with the owner's one-line approval naming the step, and a recorded rollback. Merging never deploys or migrates anything.
- Cloudflare tunnel or DNS changes: prepare the exact line, the owner applies it.
- Publishing a desktop build to the update feed, and anything on the site beyond a fix (copy, privacy and terms wording, design).
- Rebuilding the dashboards (the frame-origin build argument) and moving the admin behind `headmaster.gcaplabs.com/admin` are server steps. Prepare the code and write the exact command as an owner step.
