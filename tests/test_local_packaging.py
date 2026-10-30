"""Portable import-image checks; these do not claim to run a WSL2 hypervisor."""
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('packaging', ROOT / 'scripts/prepare-local-rootfs.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class LocalImage(unittest.TestCase):
    def test_no_host_mounts_or_interop_in_first_boot_image(self):
        with tempfile.TemporaryDirectory() as folder:
            p = pathlib.Path(folder)
            rootfs, runtime, output = p/'rootfs.tar', p/'runtime', p/'output.tar'
            with tarfile.open(rootfs, 'w') as tar:
                info = tarfile.TarInfo('etc/wsl.conf')
                data = b'[automount]\nenabled=true\n'
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            runtime.write_bytes(b'example-runtime')
            packaging.build(rootfs, runtime, ROOT/'server', output, 2, 4, 'example-owner')
            with tarfile.open(output) as tar:
                self.assertEqual(tar.getnames().count('etc/wsl.conf'), 1)
                text = tar.extractfile('etc/wsl.conf').read().decode()
                self.assertIn('[automount]\nenabled=false', text)
                self.assertIn('[interop]\nenabled=false\nappendWindowsPath=false', text)
                self.assertNotIn(str(p), tar.extractfile('opt/starport-bootstrap/initialize.py').read().decode())
                self.assertIn('opt/starport-bootstrap/local_bridge.py', tar.getnames())


if __name__ == '__main__':
    unittest.main()
