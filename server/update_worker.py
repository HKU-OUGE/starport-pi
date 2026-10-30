"""Atomic operator-initiated RPC update; running controllers keep their loaded code."""
import fcntl
import hashlib
import json
import os
import pathlib
import tempfile


def apply(root, source, expected):
    root = pathlib.Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('worker_installation_required')
    target = root / 'worker.py'
    config = root / 'config.json'
    if target.is_symlink() or config.is_symlink() or not target.is_file():
        raise ValueError('invalid_worker_installation')
    cfg = json.loads(config.read_text())
    if cfg.get('format') != 1 or not pathlib.Path(cfg['state']).is_dir():
        raise ValueError('invalid_worker_installation')
    if hashlib.sha256(source).hexdigest() != expected:
        raise ValueError('worker_update_checksum')
    compile(source, 'worker.py', 'exec')
    with (pathlib.Path(cfg['state']) / 'scheduler.lock').open('a') as mutex:
        fcntl.flock(mutex, fcntl.LOCK_EX)
        old = target.read_bytes()
        if hashlib.sha256(old).hexdigest() == expected:
            return {'updated': True, 'restartRequired': False, 'sha256': expected}
        for name, data in [('worker.py.previous', old), ('worker.py', source)]:
            fd, staging = tempfile.mkstemp(prefix='.worker-update-', dir=root)
            try:
                with os.fdopen(fd, 'wb') as out:
                    out.write(data)
                    out.flush()
                    os.fsync(out.fileno())
                    os.fchmod(out.fileno(), 0o600)
                os.replace(staging, root / name)
            finally:
                if os.path.exists(staging): os.unlink(staging)
    return {'updated': True, 'restartRequired': False, 'sha256': expected}
