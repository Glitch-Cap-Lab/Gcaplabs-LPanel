"""Exact exported programs on a synthetic local POSIX tree, never Docker/network.

Requires local root for actual UID gates. Input is the unchanged JSON export of
protectedReleaseDocker.maintenancePrograms, rather than copied program text.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def main():
    assert os.geteuid() == 0, "Local root is required for actual UID checks"
    programs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    assert set(programs) == {"move", "receipt"}
    checks = 0
    with tempfile.TemporaryDirectory(prefix="headmaster-release-helper-") as raw:
        root = Path(raw)
        release_id = "a" * 64
        stage = root / (".protected-release-" + release_id)
        canonical = stage / "receipt.json"
        hooks = root / "writable-hooks"
        hooks.mkdir()
        marker = hooks / "executed"
        (hooks / "sitecustomize.py").write_text(f"open({str(marker)!r}, 'w').write('unsafe')")
        environment = {"HOME": "/", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONPATH": str(hooks)}

        def payload(phase):
            return json.dumps({"release_id": release_id, "phase": phase}).encode()

        def invoke(kind, args, data=None):
            return subprocess.run([sys.executable, "-I", "-S", "-c", programs[kind], *map(str, args)],
                                  input=data, env=environment, cwd=hooks, capture_output=True, check=False)

        def publish(data, create="0", expected=None):
            return invoke("receipt", [stage, expected or hashlib.sha256(data).hexdigest(), release_id, create], data)

        old, new = payload("old"), payload("new")
        result = publish(old, create="1")
        assert result.returncode == 0, result.stderr.decode()
        assert canonical.read_bytes() == old and canonical.stat().st_uid == 0
        assert canonical.stat().st_mode & 0o777 == 0o600 and not marker.exists()
        result = publish(new)
        assert result.returncode == 0 and canonical.read_bytes() == new
        checks += 2

        # Kill at the actual replace syscall boundary; canonical JSON is always
        # the complete old or new receipt, never the temporary partial bytes.
        for after, code in [(False, 31), (True, 32)]:
            interrupted = payload("after-interruption" if after else "before-interruption")
            wrapper = (
                "import os\noriginal=os.replace\n"
                "def interrupted_replace(*args,**kwargs):\n"
                + (" original(*args,**kwargs)\n" if after else "")
                + f" os._exit({code})\n"
                "os.replace=interrupted_replace\n"
                f"exec(compile({programs['receipt']!r},'<exact-maintenance-program>','exec'))"
            )
            result = subprocess.run([sys.executable, "-I", "-S", "-c", wrapper, str(stage),
                                     hashlib.sha256(interrupted).hexdigest(), release_id, "0"],
                                    input=interrupted, capture_output=True, env=environment, cwd=hooks)
            assert result.returncode == code
            if after:
                new = interrupted
            assert canonical.read_bytes() == new and json.loads(canonical.read_bytes())["release_id"] == release_id
            checks += 1

        result = publish(payload("incomplete"), expected="0" * 64)
        assert result.returncode != 0 and canonical.read_bytes() == new
        checks += 1

        outside = root / "outside"
        outside.mkdir(mode=0o700)
        (outside / "receipt.json").write_bytes(b"preserve")
        attempted = payload("symlink")
        temporary = stage / (".receipt-" + hashlib.sha256(attempted).hexdigest() + ".json")
        temporary.symlink_to(outside / "receipt.json")
        result = publish(attempted)
        assert result.returncode != 0 and (outside / "receipt.json").read_bytes() == b"preserve"
        assert canonical.read_bytes() == new
        temporary.unlink()
        checks += 1

        os.chown(canonical, 10000, 10000)
        result = publish(payload("wrong-owner"))
        assert result.returncode != 0 and canonical.read_bytes() == new
        os.chown(canonical, 0, 0)
        canonical.chmod(0o644)
        result = publish(payload("wrong-mode"))
        assert result.returncode != 0 and canonical.read_bytes() == new
        canonical.chmod(0o600)
        stage.chmod(0o755)
        result = publish(payload("unsafe-stage"))
        assert result.returncode != 0 and canonical.read_bytes() == new
        stage.chmod(0o700)
        checks += 3

        live = root / "installs"
        live.mkdir()
        package = live / "package"
        package.write_bytes(b"verified archive")
        os.chown(package, 10000, 10000)
        (live / "link").symlink_to("package")
        result = invoke("move", [live, stage / "failed-installs"])
        assert result.returncode == 0, result.stderr.decode()
        restored = stage / "failed-installs"
        assert (restored / "package").read_bytes() == b"verified archive"
        assert (restored / "package").stat().st_uid == 10000 and os.readlink(restored / "link") == "package"
        assert not marker.exists()
        checks += 1

        # UID10000 owns the parent and CAN rename its root0700 child. Pause the
        # unchanged program at replace, after it holds the verified directory fd.
        # The syscall barrier below is test-only; production has no pause hook.
        os.chown(root, 10000, 10000)
        secret = stage / "retained-private"
        secret.write_bytes(b"retained archive confidentiality")
        secret.chmod(0o600)
        ready, release, denied = root / "ready", root / "release", root / "denied"
        hidden = root / "renamed-stage"
        wrapper = (
            "import os,time\nfrom pathlib import Path\noriginal=os.replace\n"
            "def blocked(*args,**kwargs):\n"
            f" Path({str(ready)!r}).write_text('ready')\n"
            " deadline=time.monotonic()+10\n"
            f" while not os.path.exists({str(release)!r}):\n"
            "  assert time.monotonic()<deadline\n  time.sleep(0.01)\n"
            " return original(*args,**kwargs)\n"
            "os.replace=blocked\n"
            f"exec(compile({programs['receipt']!r},'<exact-maintenance-program>','exec'))"
        )
        race_data = payload("race")
        process = subprocess.Popen([sys.executable, "-I", "-S", "-c", wrapper, str(stage),
                                    hashlib.sha256(race_data).hexdigest(), release_id, "0"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=environment, cwd=hooks)
        process.stdin.write(race_data)
        process.stdin.close()
        deadline = time.monotonic() + 10
        while not ready.exists():
            assert process.poll() is None and time.monotonic() < deadline
            time.sleep(0.01)
        adversary = (
            "import os\nfrom pathlib import Path\n"
            f"os.rename({str(stage)!r},{str(hidden)!r})\n"
            f"os.symlink({str(outside)!r},{str(stage)!r})\n"
            "try:\n"
            f" Path({str(hidden / 'retained-private')!r}).read_bytes()\n"
            "except PermissionError:\n"
            f" Path({str(denied)!r}).write_text('denied')\n"
            f"Path({str(release)!r}).write_text('release')\n"
        )
        def demote():
            os.setgroups([])
            os.setgid(10000)
            os.setuid(10000)
        result = subprocess.run([sys.executable, "-I", "-S", "-c", adversary], preexec_fn=demote,
                                capture_output=True, cwd="/", env={"PATH": "/usr/bin:/bin"})
        assert result.returncode == 0, result.stderr.decode()
        assert process.wait(timeout=10) != 0  # Named inode check refuses success.
        assert denied.read_text() == "denied"
        assert (outside / "receipt.json").read_bytes() == b"preserve"
        assert (hidden / "receipt.json").read_bytes() == race_data
        result = publish(payload("must-not-follow"))
        assert result.returncode != 0 and (outside / "receipt.json").read_bytes() == b"preserve"
        checks += 2
    print(f"maintenance helper POSIX checks: {checks} passed")


if __name__ == "__main__":
    main()
