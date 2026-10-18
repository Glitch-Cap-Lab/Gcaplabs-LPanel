export {};

// Nonsecret allocation metadata. This is a persistent data-storage budget,
// not a Docker filesystem quota. Only a trusted agents row supplies disk_gb.
const HEADMASTER_STORAGE_ENV = "HEADMASTER_STORAGE_ALLOCATION_BYTES";

function storageAllocationBytes(agent: { disk_gb?: unknown } = {}): number | null {
  const gb = agent.disk_gb;
  if (typeof gb !== "number" || !Number.isSafeInteger(gb) || gb <= 0) return null;
  const bytes = gb * 1024 ** 3;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

// Shared by bootstrap and adoption. The caller fixes the root to /opt/data;
// no profile, customer body or home override can choose the configuration.
const HEADMASTER_STORAGE_WRITE_PY = `
import os
import re
import stat
import tempfile
from pathlib import Path
import yaml

def write_storage_allocation(root, raw):
    root = Path(root)
    target = root / "config.yaml"
    if root.is_symlink() or target.is_symlink():
        raise ValueError("storage config must not be a symlink")
    info = None
    config = {}
    if target.exists():
        info = target.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1_000_000:
            raise ValueError("storage config must be a bounded regular file")
        loaded = yaml.safe_load(target.read_text(encoding="utf-8"))
        config = {} if loaded is None else loaded
    if not isinstance(config, dict):
        raise ValueError("storage config must be a mapping")
    headmaster = config.get("headmaster", {})
    if not isinstance(headmaster, dict):
        raise ValueError("headmaster config must be a mapping")
    storage = headmaster.get("storage", {})
    if not isinstance(storage, dict):
        raise ValueError("storage config must be a mapping")
    raw = str(raw) if raw is not None else ""
    allocation = int(raw) if re.fullmatch(r"[1-9][0-9]{0,15}", raw) else None
    if allocation is not None and allocation > 2**53 - 1:
        allocation = None
    previous = storage.get("allocation_bytes")
    if allocation is None:
        storage.pop("allocation_bytes", None)
    else:
        storage["allocation_bytes"] = allocation
    if storage:
        headmaster["storage"] = storage
    else:
        headmaster.pop("storage", None)
    if headmaster:
        config["headmaster"] = headmaster
    else:
        config.pop("headmaster", None)
    changed = previous != allocation or (previous is not None and type(previous) is not int)
    if not changed:
        return {"ok": True, "mutated": False}
    root.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".storage-config-", dir=root)
    try:
        os.fchmod(fd, 0o600)
        if info is not None:
            os.fchown(fd, info.st_uid, info.st_gid)
        else:
            import pwd
            try:
                user = pwd.getpwnam("hermes")
                os.fchown(fd, user.pw_uid, user.pw_gid)
            except KeyError:
                pass
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            yaml.safe_dump(config, stream, sort_keys=False, allow_unicode=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, target)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return {"ok": True, "mutated": True}
`;

module.exports = { HEADMASTER_STORAGE_ENV, HEADMASTER_STORAGE_WRITE_PY, storageAllocationBytes };
