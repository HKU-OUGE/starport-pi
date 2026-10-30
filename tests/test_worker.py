import base64
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import tarfile
import tempfile
import sys
import unittest
from unittest.mock import patch

if sys.platform != 'linux':
    reason = 'Linux worker tests require fcntl, sched_getaffinity and Linux file-descriptor semantics.'
    if __name__ == '__main__':
        print('SKIP: ' + reason)
        sys.exit(0)
    raise unittest.SkipTest(reason)

BASE=pathlib.Path(__file__).resolve().parents[1]
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
worker=module('worker',BASE/'server/worker.py')
installer=module('installer',BASE/'server/install.py')
updater=module('updater',BASE/'server/update_worker.py')


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        for d in ['workspaces','jobs','datasets','uploads']:(self.root/d).mkdir()
        self.cfg={'state':str(self.root),'cpu_indices':sorted(os.sched_getaffinity(0))[:2],'memory_gib':4,'gpu_indices':[],
            'egress_socket':str(self.root/'absent.sock')}
        self.wid=worker.dispatch(self.cfg,{'operation':'workspace.create'})['id'];self.ws=self.root/'workspaces'/self.wid
    def tearDown(self):self.temp.cleanup()
    def call(self,op,**args):return worker.dispatch(self.cfg,{'operation':op,'workspace':self.wid,**args})
    def test_unicode_and_scope(self):
        self.call('file.write',path='資料/文字.txt',content='繁體中文')
        r=self.call('file.read',path='資料/文字.txt');self.assertEqual(base64.b64decode(r['data']).decode(),'繁體中文')
        for value in ['../secret','/etc/passwd','a/../../b','C:\\file','a//b']:
            with self.assertRaises(ValueError):self.call('file.read',path=value)
    def test_links_and_special_files(self):
        outside=self.root/'secret';outside.write_text('private')
        (self.ws/'link').symlink_to(outside)
        with self.assertRaises(OSError):self.call('file.read',path='link')
        (self.ws/'dir').symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(OSError):self.call('file.write',path='dir/secret',content='changed')
        self.assertEqual(outside.read_text(),'private')
        os.mkfifo(self.ws/'pipe')
        with self.assertRaises(ValueError):self.call('file.read',path='pipe')
    def test_immutable_dataset_and_link_rejection(self):
        self.call('file.write',path='data/a.txt',content='original');r=self.call('dataset.publish',path='data')
        self.call('file.write',path='data/a.txt',content='changed')
        self.assertEqual((self.root/'datasets'/r['id']/'payload/a.txt').read_text(),'original')
        (self.ws/'data/link').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):self.call('dataset.publish',path='data')
    def test_chunk_resume_checksum_and_finish_retry(self):
        body='文字'.encode()*100;h=hashlib.sha256(body).hexdigest()
        grant=self.call('upload.begin',path='assets/data.bin',bytes=len(body),sha256=h)
        chunk={'upload':grant['id'],'offset':0,'data':base64.b64encode(body).decode(),'sha256':h}
        self.call('upload.chunk',**chunk);self.call('upload.chunk',**chunk)
        result=self.call('upload.finish',upload=grant['id']);self.assertEqual(result['sha256'],h)
        self.assertEqual(self.call('upload.finish',upload=grant['id']),result)
        self.assertFalse((self.root/'uploads'/grant['id']/'content').exists())
        self.assertEqual((self.ws/'assets/data.bin').read_bytes(),body)
        # Simulate a process exit after the final rename but before its receipt.
        (self.root/'uploads'/grant['id']/'receipt.json').unlink()
        self.assertEqual(self.call('upload.finish',upload=grant['id']),result)
    def test_dead_controller_releases_only_its_own_job(self):
        with patch.object(worker.subprocess,'Popen') as process:
            process.return_value.pid=12345
            row=self.call('job.submit',command='true',cpus=1,memory_gib=1)
        record=self.root/'jobs'/row['id']/'status.json';state=worker.read_json(record)
        state['created_at']=0;state['controller_stamp']='old';worker.save(record,state)
        with patch.object(worker,'process_stamp',return_value='different'),patch.object(worker,'cleanup',return_value=True) as cleanup:
            worker.reconcile(self.cfg)
        self.assertEqual(cleanup.call_count,1)
        self.assertEqual(worker.read_json(record)['error'],'controller_interrupted')
        self.assertTrue(worker.read_json(record)['released'])
    def test_quiet_live_controller_is_never_reaped(self):
        with patch.object(worker.subprocess,'Popen') as process,patch.object(worker,'process_stamp',return_value='same'):
            process.return_value.pid=12345
            row=self.call('job.submit',command='sleep 3600',cpus=1,memory_gib=1)
        record=self.root/'jobs'/row['id']/'status.json';state=worker.read_json(record);state['created_at']=0;worker.save(record,state)
        with patch.object(worker,'process_stamp',return_value='same'),patch.object(worker,'cleanup') as cleanup:
            worker.reconcile(self.cfg)
        cleanup.assert_not_called();self.assertFalse(worker.read_json(record)['released'])
    def test_quota_and_workspace_reservations(self):
        with self.assertRaisesRegex(ValueError,'cpu_capacity'):self.call('job.submit',command='true',cpus=999)
        with self.assertRaisesRegex(ValueError,'gpu_driver'):self.call('job.submit',command='true',gpus=1)
        with patch.object(worker.subprocess,'Popen') as process:
            process.return_value.pid=12345
            r=self.call('job.submit',command='printf test',cpus=1,memory_gib=1)
            self.assertEqual(r['status'],'queued')
            self.assertNotIn('cpu_indices',r)
            with self.assertRaisesRegex(ValueError,'workspace_busy'):self.call('job.submit',command='true',cpus=1,memory_gib=1)
        other=worker.dispatch(self.cfg,{'operation':'workspace.create'})['id']
        with self.assertRaisesRegex(ValueError,'job_not_found'):worker.dispatch(self.cfg,{'operation':'job.cancel','workspace':other,'job':r['id']})
    def test_unknown_operator_fields_rejected(self):
        with self.assertRaisesRegex(ValueError,'unsupported_operation'):self.call('file.read',path='x',host='/')
        with self.assertRaisesRegex(ValueError,'unsupported_operation'):self.call('shell.local',command='true')

    def test_manage_files_with_versions_and_scope(self):
        self.call('file.manage',action='mkdir',path='data')
        self.call('file.manage',action='save',path='data/file.txt',content='original')
        listing=self.call('file.list',path='data')
        self.assertEqual(listing['capabilities']['fileManagement'],1)
        version=listing['entries'][0]['version']
        self.call('file.manage',action='save',path='data/file.txt',content='updated',version=version)
        with self.assertRaisesRegex(ValueError,'file_changed_refresh'):
            self.call('file.manage',action='save',path='data/file.txt',content='stale',version=version)
        current=self.call('file.read',path='data/file.txt')['version']
        self.call('file.manage',action='rename',path='data/file.txt',destination='moved.txt',version=current)
        self.assertEqual((self.ws/'moved.txt').read_text(),'updated')
        with self.assertRaisesRegex(ValueError,'file_exists'):
            self.call('file.manage',action='save',path='moved.txt',content='overwrite')
        current=self.call('file.read',path='moved.txt')['version']
        with self.assertRaisesRegex(ValueError,'confirmation'):
            self.call('file.manage',action='delete',path='moved.txt',version=current)
        self.call('file.manage',action='delete',path='moved.txt',version=current,confirmPath='moved.txt')
        for path in ['.','../outside','/etc/passwd','data/../../outside']:
            with self.assertRaises(ValueError):self.call('file.manage',action='mkdir',path=path)
        secret=self.root/'secret';secret.write_text('keep')
        (self.ws/'data/link').symlink_to(secret)
        version=self.call('file.list')['entries'][0]['version']
        self.call('file.manage',action='delete',path='data',version=version,confirmPath='data')
        self.assertEqual(secret.read_text(),'keep');self.assertFalse((self.ws/'data').exists())

    def test_upload_collision_and_active_workspace_preserve_staged_bytes(self):
        data=b'complete upload';h=hashlib.sha256(data).hexdigest()
        grant=self.call('upload.begin',path='file.bin',bytes=len(data),sha256=h)
        self.call('upload.chunk',upload=grant['id'],offset=0,data=base64.b64encode(data).decode(),sha256=h)
        record=self.root/'jobs'/('b'*32)/'status.json'
        worker.save(record,{'workspace':self.wid,'released':False})
        with self.assertRaisesRegex(ValueError,'workspace_busy'):
            self.call('upload.finish',upload=grant['id'])
        with self.assertRaisesRegex(ValueError,'workspace_busy'):
            self.call('file.manage',action='mkdir',path='blocked')
        worker.save(record,{'workspace':self.wid,'released':True})
        (self.ws/'file.bin').write_bytes(b'new content')
        with self.assertRaisesRegex(ValueError,'file_exists'):self.call('upload.finish',upload=grant['id'])
        self.assertEqual((self.ws/'file.bin').read_bytes(),b'new content')
        (self.ws/'file.bin').unlink()
        staged=self.root/'uploads'/grant['id']/'content'
        os.link(staged,self.ws/'file.bin')  # Simulate acknowledgement loss between link and cleanup.
        result=self.call('upload.finish',upload=grant['id'])
        self.assertEqual(result['sha256'],h);self.assertFalse(staged.exists())
        with self.assertRaisesRegex(ValueError,'file_exists'):
            self.call('upload.begin',path='file.bin',bytes=len(data),sha256=h)

    def test_operator_worker_update_preserves_configuration_and_active_state(self):
        install=self.root/'installation';install.mkdir()
        (install/'config.json').write_text(json.dumps({'format':1,'state':str(self.root)}))
        (install/'worker.py').write_text('old = True\n')
        (self.ws/'project.txt').write_text('keep')
        record=self.root/'jobs'/('c'*32)/'status.json'
        worker.save(record,{'workspace':self.wid,'released':False})
        before=record.read_bytes();config=(install/'config.json').read_bytes()
        source=b'new = True\n';h=hashlib.sha256(source).hexdigest()
        with self.assertRaisesRegex(ValueError,'checksum'):updater.apply(install,source,'0'*64)
        result=updater.apply(install,source,h)
        self.assertFalse(result['restartRequired'])
        self.assertEqual((install/'worker.py').read_bytes(),source)
        self.assertEqual((install/'worker.py.previous').read_text(),'old = True\n')
        updater.apply(install,source,h)
        self.assertEqual((install/'worker.py.previous').read_text(),'old = True\n')
        self.assertEqual((install/'config.json').read_bytes(),config)
        self.assertEqual(record.read_bytes(),before);self.assertEqual((self.ws/'project.txt').read_text(),'keep')


class ArchiveTests(unittest.TestCase):
    def archive(self,folder,entries):
        p=folder/'input.tar'
        with tarfile.open(p,'w') as tar:
            for name,body,kind in entries:
                m=tarfile.TarInfo(name)
                if kind=='file':m.size=len(body);tar.addfile(m,io.BytesIO(body))
                else:m.type=tarfile.SYMTYPE;m.linkname=body;tar.addfile(m)
        return p
    def test_archive_traversal_never_writes_outside(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);dest=root/'dest';dest.mkdir()
            p=self.archive(root,[('../outside',b'bad','file')])
            with self.assertRaises(ValueError):installer.unpack(p,dest)
            self.assertFalse((root/'outside').exists())
    def test_archive_symlink_parent_never_traversed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);dest=root/'dest';dest.mkdir();outside=root/'outside';outside.mkdir()
            p=self.archive(root,[('link',str(outside),'link'),('link/escape',b'bad','file')])
            with self.assertRaises((ValueError,OSError)):installer.unpack(p,dest)
            self.assertFalse((outside/'escape').exists())


if __name__=='__main__':unittest.main()
