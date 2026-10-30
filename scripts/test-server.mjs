import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  console.log('[SKIP] Linux worker tests require Linux (fcntl, affinity and safe file descriptors).');
  console.log('Run npm test for the native client. Validate the worker on a Linux server or Linux CI.');
} else {
  const result = spawnSync(process.env.STARPORT_PYTHON || 'python3',
    ['-I', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' });
  if (result.error) console.error('Unable to start Python 3.12+ for Linux worker tests.');
  process.exitCode = result.status ?? 1;
}
