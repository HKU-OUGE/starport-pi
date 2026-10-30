"""Install a private, additive runsc worker on an existing Linux/DSW server."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import uuid
import contextlib


@contextlib.contextmanager
def parent_fd(root,parts):
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts:
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=nxt
        yield fd
    finally:os.close(fd)


def sha(path):
    result=hashlib.sha256()
    with open(path,'rb') as stream:
        for data in iter(lambda:stream.read(1024*1024),b''):result.update(data)
    return result.hexdigest()


def unpack(archive,destination):
    """Extract regular files first and links last; never traverse an archive link."""
    links=[];total=0;seen=set()
    with tarfile.open(archive,'r:*') as tar:
        members=tar.getmembers()
        if len(members)>150000:raise ValueError('rootfs_file_limit')
        for member in members:
            relative=pathlib.PurePosixPath(member.name.removeprefix('./'))
            if str(relative)=='.':continue
            if relative.is_absolute() or '..' in relative.parts or str(relative) in seen:raise ValueError('invalid_rootfs_path')
            seen.add(str(relative));target=destination/relative
            if member.issym() or member.islnk():links.append((member,target));continue
            if not member.isdir() and not member.isfile():
                if relative.parts[0]=='dev':continue
                raise ValueError('rootfs_special_file')
            target.parent.mkdir(parents=True,exist_ok=True)
            if member.isdir():target.mkdir(exist_ok=True);target.chmod(member.mode&0o755)
            else:
                total+=member.size
                if total>6*1024**3:raise ValueError('rootfs_size_limit')
                with tar.extractfile(member) as source,target.open('xb') as out:shutil.copyfileobj(source,out,1024*1024)
                target.chmod(member.mode&0o755)
        for member,target in links:target.parent.mkdir(parents=True,exist_ok=True)
        for member,target in links:
            destination_parts=target.relative_to(destination).parts
            if member.islnk():
                source=pathlib.PurePosixPath(member.linkname.removeprefix('./'))
                if source.is_absolute() or '..' in source.parts:raise ValueError('invalid_rootfs_link')
                with parent_fd(destination,source.parts[:-1]) as source_fd,parent_fd(destination,destination_parts[:-1]) as dest_fd:
                    import stat
                    st=os.stat(source.name,dir_fd=source_fd,follow_symlinks=False)
                    if not stat.S_ISREG(st.st_mode):raise ValueError('invalid_rootfs_link')
                    os.link(source.name,destination_parts[-1],src_dir_fd=source_fd,dst_dir_fd=dest_fd,follow_symlinks=False)
            else:
                if '\x00' in member.linkname:raise ValueError('invalid_rootfs_link')
                # Absolute targets resolve inside the guest; no further extraction follows them.
                with parent_fd(destination,destination_parts[:-1]) as fd:os.symlink(member.linkname,destination_parts[-1],dir_fd=fd)


def runtime(source,target,expected=None,version='20261026.0'):
    if source:
        if not expected or sha(source)!=expected:raise ValueError('runtime_checksum_required')
        shutil.copyfile(source,target)
        sidecars=source.parent/'gvisor-bin'
        if not sidecars.is_dir():raise ValueError('runtime_sidecars_required')
        output=target.parent/'gvisor-bin';output.mkdir()
        for file in sidecars.iterdir():
            if file.is_symlink() or not file.is_file():raise ValueError('invalid_runtime_sidecar')
            shutil.copyfile(file,output/file.name);(output/file.name).chmod(0o755)
    else:
        machine=os.uname().machine
        if machine not in ('x86_64','aarch64'):raise ValueError('unsupported_server_architecture')
        arch='x86_64' if machine=='x86_64' else 'aarch64'
        base=f'https://storage.googleapis.com/gvisor/releases/release/{version}/{arch}/gvisor.tar.bz2'
        expected=urllib.request.urlopen(base+'.sha512',timeout=30).read(4096).decode().split()[0]
        with tempfile.TemporaryDirectory(dir=target.parent) as folder:
            folder=pathlib.Path(folder);archive=folder/'runtime.tar.bz2'
            with urllib.request.urlopen(base,timeout=120) as source,archive.open('wb') as out:shutil.copyfileobj(source,out,1024*1024)
            h=hashlib.sha512()
            with archive.open('rb') as f:
                for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
            if h.hexdigest()!=expected:raise ValueError('runtime_download_checksum')
            unpack(archive,folder/'unpacked')
            extracted=folder/'unpacked'
            shutil.move(extracted/'runsc',target)
            shutil.move(extracted/'gvisor-bin',target.parent/'gvisor-bin')
    target.chmod(0o755)
    subprocess.run([str(target),'--version'],check=True,capture_output=True,timeout=15)
    files={'runsc':sha(target)}
    for file in (target.parent/'gvisor-bin').iterdir():
        if file.is_symlink() or not file.is_file():raise ValueError('invalid_runtime_sidecar')
        files['gvisor-bin/'+file.name]=sha(file)
    return files


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--rootfs',required=True,type=pathlib.Path)
    parser.add_argument('--sha256',required=True)
    parser.add_argument('--runsc',type=pathlib.Path)
    parser.add_argument('--runsc-sha256')
    parser.add_argument('--cpus',type=int,default=4)
    parser.add_argument('--cpu-indices',help='Optional explicit Linux CPU indices')
    parser.add_argument('--memory-gib',type=int,default=8)
    parser.add_argument('--platform',choices=['systrap','ptrace'],default='systrap')
    parser.add_argument('--root',type=pathlib.Path,default=pathlib.Path.home()/'.local/share/starport-pi-server')
    args=parser.parse_args()
    if sys.platform!='linux':raise SystemExit('Server installation requires Linux. The client supports Windows.')
    if sha(args.rootfs)!=args.sha256:raise ValueError('rootfs_checksum_failed')
    affinity=sorted(os.sched_getaffinity(0))
    cpus=[int(x) for x in args.cpu_indices.split(',')] if args.cpu_indices else affinity[:args.cpus]
    if args.memory_gib<2 or len(cpus)!=args.cpus or not set(cpus)<=set(affinity):raise ValueError('invalid_server_budget')
    root=args.root.expanduser().absolute()
    if root.exists():raise ValueError('installation_exists_use_separate_directory')
    root.parent.mkdir(parents=True,exist_ok=True)
    stage=pathlib.Path(tempfile.mkdtemp(prefix='starport-install-',dir=root.parent))
    try:
        (stage/'rootfs').mkdir();unpack(args.rootfs,stage/'rootfs')
        for required in ['usr/local/bin/python3','bin/bash','opt/starport/guest_entry.py','opt/starport/probe.py','opt/starport/region.json','etc/fonts/starport.conf']:
            # Resolve guest absolute symlinks under the staged root for checks.
            p=stage/'rootfs'/required
            if not p.exists() and not p.is_symlink():raise ValueError('rootfs_incomplete')
        binaries=runtime(args.runsc,stage/'runsc',args.runsc_sha256)
        for name in ['worker.py','configure_gpu.py']:
            shutil.copyfile(pathlib.Path(__file__).with_name(name),stage/name)
        shutil.copyfile(stage/'rootfs/opt/starport/region.json',stage/'region.json')
        state=root/'state'
        egress=pathlib.Path('/tmp')/('starport-egress-'+uuid.uuid4().hex)
        egress.mkdir(mode=0o700)
        (stage/'rootfs/run/starport/egress.sock').touch()
        cfg={'format':1,'state':str(state),'rootfs':str(root/'rootfs'),'runsc':str(root/'runsc'),
            'runsc_sha256':binaries['runsc'],'runtime_files':binaries,'region_sha256':sha(stage/'region.json'),'cpu_indices':cpus,
            'memory_gib':args.memory_gib,'max_parallel':min(args.cpus,8),'gpu_indices':[],'driver_files':[],
            'platform':args.platform,'egress_socket':str(egress/'proxy.sock')}
        (stage/'config.json').write_text(json.dumps(cfg,indent=2));(stage/'config.json').chmod(0o600)
        for part in ['workspaces','jobs','datasets','uploads']:(stage/'state'/part).mkdir(parents=True,mode=0o700)
        stage.chmod(0o700);stage.rename(root)
        print(json.dumps({'installed':True,'region':'taiwan-utf8-v1','cpus':len(cpus),'memory_gib':args.memory_gib,
            'gpu_enabled':False,'rootfs_sha256':args.sha256,'runsc_sha256':binaries['runsc'],'restart_required':False}))
    except BaseException:
        if stage.exists():shutil.rmtree(stage)
        raise


if __name__=='__main__':main()
