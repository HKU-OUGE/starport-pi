"""OpenSSH ProxyCommand adapter; raw cloud diagnostics never reach model tools."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time


def classify_error(text):
    text = text.lower()
    if 'entity does not exist' in text or 'instancenotfound' in text:
        return 'dsw_instance_not_found_check_id_and_region'
    if any(x in text for x in ['invalidaccesskeyid', 'signaturedoesnotmatch', 'accesskeydisabled', 'invalidsecuritytoken', 'securitytokenexpired']):
        return 'dsw_credentials_rejected'
    if any(x in text for x in ['forbidden', 'notauthorized', 'accessdenied', 'permission denied']):
        return 'dsw_token_permission_denied'
    return 'dsw_connection_failed'


def record_failure(root, name, error):
    folder = root / 'connections' / name
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    next_file = folder / ('proxy-status-' + str(os.getpid()) + '.next')
    next_file.write_text(json.dumps({'error': error, 'checkedAt': time.time()}))
    next_file.chmod(0o600)
    next_file.replace(folder / 'proxy-status.json')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--state', required=True)
    p.add_argument('--server', required=True)
    a = p.parse_args()
    if not re.fullmatch('[a-z][a-z0-9-]{0,39}', a.server):
        return 1
    root = pathlib.Path(a.state)
    try:
        cfg = json.loads((root/'config.json').read_text())['servers'][a.server]
        if cfg['mode'] != 'dsw' or not re.fullmatch('dsw-[a-z0-9]{12,64}', cfg['instanceId']):
            record_failure(root, a.server, 'dsw_instance_not_found_check_id_and_region')
            return 1
        child = subprocess.Popen([cfg['proxyClient'], 'connect', '--region-id='+cfg['region'],
            '--instance-id='+cfg['instanceId'], '--config-file='+cfg['credentialsFile']],
            stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=subprocess.PIPE)
        tail = b''
        while True:
            chunk = child.stderr.read(4096)
            if not chunk:
                break
            tail = (tail+chunk)[-16384:]
        code = child.wait()
        if code:
            record_failure(root, a.server, classify_error(tail.decode('utf-8', errors='replace')))
        return code
    except Exception:
        print('DSW connection failed. Check the private connection profile.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
