"""Retention for the stage folders a protected release leaves in a bot's data volume.

Every release copies the whole install into <root>/.protected-release-<id>/before so a failed
candidate can be put back (4 to 6 GB each), and a restore moves what the candidate wrote into
failed-installs next to it. Nothing removed them, so one bot's volume held 51 GB.

  python -I -S - <root> <current stage name or -> <keep> <owner uid> <apply 0|1>

Rules, in this order of importance:
  - The stage named <current> (the release in progress) is never touched.
  - Only a stage whose receipt.json says "external_metadata_pending" (committed) or "rolled_back" is
    judged. Any other phase, a missing or unreadable receipt, a symlink or a folder owned by someone
    else may still be needed for a recovery and is left alone.
  - Of the committed stages, the <keep> newest are kept, <current> counting as one, so the last good
    snapshot always survives. Older committed stages lose only their "before" folder.
  - failed-* folders and files are removed from every judged stage. A rolled-back stage keeps nothing
    but its receipt.json (its presence is what stops the same release being applied again).
  - receipt.json is never removed.
Nothing is removed unless <apply> is 1; the JSON report on stdout is the dry-run listing. Removal walks
by directory file descriptor and never follows a symlink.
"""
import json, os, re, stat, sys

STAGE = re.compile(r"\.protected-release-[0-9a-f]{64}")
COMMITTED, ROLLED_BACK = "external_metadata_pending", "rolled_back"
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def usage(fd):
    total = 0
    for _, _, files, dirfd in os.fwalk(".", dir_fd=fd, follow_symlinks=False):
        total += sum(os.stat(name, dir_fd=dirfd, follow_symlinks=False).st_size for name in files)
    return total


def entry_bytes(fd, name):
    meta = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISDIR(meta.st_mode):
        return meta.st_size
    inner = os.open(name, DIR, dir_fd=fd)
    try:
        return usage(inner)
    finally:
        os.close(inner)


def remove(fd, name):
    if not stat.S_ISDIR(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
        os.unlink(name, dir_fd=fd)
        return
    top = os.open(name, DIR, dir_fd=fd)
    try:
        for _, dirs, files, dirfd in os.fwalk(".", topdown=False, dir_fd=top, follow_symlinks=False):
            for file in files:
                os.unlink(file, dir_fd=dirfd)
            for sub in dirs:
                linked = stat.S_ISLNK(os.stat(sub, dir_fd=dirfd, follow_symlinks=False).st_mode)
                (os.unlink if linked else os.rmdir)(sub, dir_fd=dirfd)
    finally:
        os.close(top)
    os.rmdir(name, dir_fd=fd)


def read_receipt(fd, owner):
    """(phase, mtime) of a stage's receipt.json, or (None, 0) when it is missing, not ours or not JSON."""
    try:
        file = os.open("receipt.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    except OSError:
        return None, 0
    try:
        meta = os.fstat(file)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != owner or meta.st_size > 65536:
            return None, 0
        phase = json.loads(os.read(file, 65537)).get("phase")
        return (phase if isinstance(phase, str) else None), meta.st_mtime_ns
    except (ValueError, AttributeError):
        return None, 0
    finally:
        os.close(file)


def main():
    root, current, keep, owner, apply = sys.argv[1:]
    keep, owner, apply = int(keep), int(owner), apply == "1"
    assert keep >= 2 and (current == "-" or STAGE.fullmatch(current)), "keep at least two; current is a stage name or -"
    rootfd = os.open(root, DIR)
    stages = []
    for name in sorted(os.listdir(rootfd)):
        if not STAGE.fullmatch(name):
            continue
        meta = os.stat(name, dir_fd=rootfd, follow_symlinks=False)
        stage = {"name": name, "phase": None, "mtime": 0, "entries": [], "action": "left alone: not a folder owned by the release"}
        if stat.S_ISDIR(meta.st_mode) and meta.st_uid == owner:
            stage["fd"] = os.open(name, DIR, dir_fd=rootfd)
            stage["phase"], stage["mtime"] = read_receipt(stage["fd"], owner)
            stage["action"] = "left alone: release in progress" if name == current else "left alone: phase %s may still be recovered" % stage["phase"]
        stages.append(stage)
    committed = sorted((s for s in stages if s["phase"] == COMMITTED and s["name"] != current),
                       key=lambda s: (s["mtime"], s["name"]), reverse=True)
    newest = {s["name"] for s in committed[:keep - (current != "-")]}
    for stage in stages:
        if stage["name"] == current or stage["phase"] not in (COMMITTED, ROLLED_BACK):
            continue
        present = os.listdir(stage["fd"])
        if stage["phase"] == ROLLED_BACK:
            stage["entries"] = [e for e in present if e != "receipt.json"]
            stage["action"] = "failed attempt: everything but receipt.json goes"
        else:
            stage["entries"] = [e for e in present if e.startswith("failed-") or (e == "before" and stage["name"] not in newest)]
            stage["action"] = "kept: last good snapshot" if stage["name"] in newest else "older release: snapshot goes"
    freed, report = 0, []
    for stage in stages:
        removed = []
        for entry in stage["entries"]:
            size = entry_bytes(stage["fd"], entry)
            if apply:
                remove(stage["fd"], entry)
            removed.append({"entry": entry, "bytes": size})
            freed += size
        if stage.get("fd") is not None:
            os.close(stage["fd"])
        report.append({"name": stage["name"], "phase": stage["phase"], "action": stage["action"], "remove": removed})
    os.close(rootfd)
    sys.stdout.write(json.dumps({"applied": apply, "current": current, "keep": keep, "freed_bytes": freed, "stages": report}) + "\n")


main()
