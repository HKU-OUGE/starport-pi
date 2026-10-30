"""OpenSSH ProxyCommand adapter; credentials remain in the operator's private file."""
import argparse
import json
import os
import pathlib
import subprocess
import sys

p=argparse.ArgumentParser()
p.add_argument('--state',required=True)
p.add_argument('--server',required=True)
a=p.parse_args()
try:
    cfg=json.loads((pathlib.Path(a.state)/'config.json').read_text())['servers'][a.server]
    if cfg['mode']!='dsw':raise ValueError()
    result=subprocess.run([cfg['proxyClient'],'connect','--region-id='+cfg['region'],
        '--instance-id='+cfg['instanceId'],'--config-file='+cfg['credentialsFile']],
        stdin=sys.stdin.buffer,stdout=sys.stdout.buffer,stderr=subprocess.DEVNULL)
    sys.exit(result.returncode)
except Exception:
    print('DSW connection failed. Check the private connection profile.',file=sys.stderr)
    sys.exit(1)
