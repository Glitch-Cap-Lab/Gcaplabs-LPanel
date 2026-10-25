#!/usr/bin/env python3
"""Fail a change that adds repository clutter.

Judged on what the change ADDS (base -> head), so files that already exist are never flagged:

* a new root-level ``.md`` file other than README, LICENSE, NOTICE, CONTRIBUTING, SECURITY,
  AGENTS.md, CLAUDE.md, GEMINI.md and CHANGELOG (translations such as ``README.es.md`` pass);
* a new file over 1 MB (host it elsewhere, or link it);
* a new ``components-*.md`` or ``Ultimate-*.md`` dump, a branding-prompt note, or anything
  under an ``_archive`` folder.

    python scripts/check-repo-hygiene.py                    # HEAD vs merge-base with origin/main
    python scripts/check-repo-hygiene.py --base HEAD^1      # CI: the PR merge commit vs its base
    python scripts/check-repo-hygiene.py --base A --head B  # any two revisions

Exit codes: 0 = clean, 1 = at least one offender, 2 = git or usage error.
"""
from __future__ import annotations

import argparse
import fnmatch
import subprocess
import sys

MAX_BYTES = 1024 * 1024
ROOT_MD_OK = (
    "README*.md", "LICENSE*.md", "NOTICE*.md", "CONTRIBUTING*.md", "SECURITY*.md",
    "AGENTS.md", "CLAUDE.md", "GEMINI.md", "CHANGELOG*.md",
)
CLUTTER_NAMES = ("components-*.md", "Ultimate-*.md", "*branding-prompt*.md")
_ZERO = "0" * 40


def git(*args: str) -> str:
    proc = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8",
                          errors="surrogateescape", stdin=subprocess.DEVNULL, timeout=120, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {proc.stderr.strip()}")
    return proc.stdout


def merge_base(head: str) -> str:
    for ref in ("origin/main", "main"):
        try:
            out = git("merge-base", head, ref).strip()
        except RuntimeError:
            continue
        if out:
            return out
    raise RuntimeError("no merge-base with origin/main or main; pass --base")


def added(base: str, head: str) -> list[tuple[str, str, str]]:
    """(status, path, blob sha) for each added, copied or renamed path; status A, C or R."""
    fields = git("diff", "--raw", "-z", "-M", "--diff-filter=ACR", base, head).split("\0")
    out, i = [], 0
    while i < len(fields) and fields[i].startswith(":"):
        meta = fields[i][1:].split()
        code = meta[4][0]
        step = 3 if code in "RC" else 2
        out.append((code, fields[i + step - 1], meta[3]))
        i += step
    return out


def offenders(changes: list[tuple[str, str, str]]) -> list[str]:
    found = []
    for code, path, sha in changes:
        parts = path.split("/")
        name = parts[-1]
        if len(parts) == 1 and name.lower().endswith(".md") and not any(
                fnmatch.fnmatchcase(name.upper(), pat.upper()) for pat in ROOT_MD_OK):
            found.append(f"{path}: new root-level .md (allowed: README, LICENSE, NOTICE, CONTRIBUTING, "
                         "SECURITY, AGENTS.md, CLAUDE.md, GEMINI.md, CHANGELOG); put it under docs/")
        if "_archive" in parts[:-1] or any(fnmatch.fnmatchcase(name, pat) for pat in CLUTTER_NAMES):
            found.append(f"{path}: archive folders and components-*, Ultimate-* and branding-prompt "
                         "dumps are not kept in the tree")
        if code in "AC" and sha != _ZERO:
            size = int(git("cat-file", "-s", sha).strip())
            if size > MAX_BYTES:
                found.append(f"{path}: new file is {size / 1048576:.1f} MB, over the 1 MB limit")
    return found


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--base")
    ap.add_argument("--head", default="HEAD")
    args = ap.parse_args()
    try:
        found = offenders(added(args.base or merge_base(args.head), args.head))
    except RuntimeError as exc:
        print(f"check-repo-hygiene: {exc}", file=sys.stderr)
        return 2
    if found:
        print("Repository hygiene check failed:")
        for line in found:
            print(f"  {line}")
        print("Reproduce locally: python scripts/check-repo-hygiene.py")
        return 1
    print("check-repo-hygiene: nothing added that the hygiene rules forbid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
