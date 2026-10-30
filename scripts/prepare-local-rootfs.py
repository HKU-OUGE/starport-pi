"""Build the owned WSL import image without extracting files on Windows."""
import argparse
import hashlib
import io
import json
import pathlib
import tarfile

WSL_CONFIG = b'''[automount]
enabled=false
mountFsTab=false
[interop]
enabled=false
appendWindowsPath=false
[network]
hostname=starport-runtime
'''


def build(rootfs, runtime, source, output, cpus, memory, owner):
    if output.exists():
        raise ValueError('bootstrap_archive_exists')
    if not 1 <= cpus <= 64 or not 2 <= memory <= 256:
        raise ValueError('invalid_local_budget')
    hashes = {}
    for name, file in [('rootfs', rootfs), ('runtime', runtime)]:
        h = hashlib.sha256()
        with file.open('rb') as stream:
            for b in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(b)
        hashes[name] = h.hexdigest()
    with tarfile.open(output, 'w') as out:
        with tarfile.open(rootfs, 'r:*') as inp:
            for item in inp:
                name = pathlib.PurePosixPath(item.name.removeprefix('./'))
                if name.is_absolute() or '..' in name.parts:
                    raise ValueError('invalid_rootfs_path')
                if str(name) in ('etc/wsl.conf', 'opt/starport-bootstrap') or str(name).startswith('opt/starport-bootstrap/'):
                    continue
                out.addfile(item, inp.extractfile(item) if item.isfile() else None)
        def add(name, data, mode=0o600):
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), mode
            out.addfile(info, io.BytesIO(data))
        add('etc/wsl.conf', WSL_CONFIG, 0o644)
        for filename in ['install.py', 'worker.py', 'configure_gpu.py', 'local_bridge.py']:
            add('opt/starport-bootstrap/' + filename, (source / filename).read_bytes())
        # Keep verified archives only until the additive worker install completes.
        def neutral(info):
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            info.pax_headers = {}
            return info
        out.add(rootfs, arcname='opt/starport-bootstrap/rootfs.tar', recursive=False, filter=neutral)
        out.add(runtime, arcname='opt/starport-bootstrap/runtime.tar.bz2', recursive=False, filter=neutral)
        add('opt/starport-bootstrap/owner', owner.encode())
        installer = f'''import pathlib,subprocess,sys
p=pathlib.Path('/opt/starport-bootstrap')
subprocess.run([sys.executable,'-I',str(p/'install.py'),'--root','/opt/starport/worker',
 '--rootfs',str(p/'rootfs.tar'),'--sha256',{hashes['rootfs']!r},
 '--runtime-archive',str(p/'runtime.tar.bz2'),'--runtime-sha256',{hashes['runtime']!r},
 '--cpus',{str(cpus)!r},'--memory-gib',{str(memory)!r}],check=True)
for name in ['rootfs.tar','runtime.tar.bz2']:(p/name).unlink()
'''
        add('opt/starport-bootstrap/initialize.py', installer.encode())


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for name in ['rootfs', 'runtime', 'source', 'output']:
        p.add_argument('--' + name, type=pathlib.Path, required=True)
    p.add_argument('--cpus', type=int, required=True)
    p.add_argument('--memory', type=int, required=True)
    p.add_argument('--owner', required=True)
    a = p.parse_args()
    build(a.rootfs, a.runtime, a.source, a.output, a.cpus, a.memory, a.owner)
    print(json.dumps({'prepared': True}))
