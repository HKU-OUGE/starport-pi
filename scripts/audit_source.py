"""Fail publication if candidate source contains credentials or deployment state."""
import pathlib
import re
import subprocess
import sys

root=pathlib.Path(__file__).resolve().parents[1]
files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
patterns={
    'private_key':r'-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----',
    'provider_secret':r'\b(?:sk-ant-api\w*-|gh[pousr]_)[A-Za-z0-9_-]{20,}',
    'cloud_access_key':r'\bLTAI[A-Za-z0-9]{12,}',
    'cloud_instance':r'\bdsw-[a-z0-9]{12,}\b',
    'personal_home':r'/(?:home|Users)/(?!(?:example|user|<username>|worker|runner|starport)(?:/|\b))[A-Za-z0-9_.-]+/',
    'windows_home':r'[A-Z]:[\\/]Users[\\/](?![<%])[A-Za-z0-9_.-]+[\\/]',
    'email':r'\b[A-Za-z0-9_.+-]+@(?!(?:[A-Za-z0-9.-]*\.)?example\.(?:invalid|com)\b|localhost\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b',
}
bad=[]
for name in sorted(set(files)-{''}):
    path=root/name
    if path.is_symlink():bad.append((name,'symlink'));continue
    if not path.is_file():continue
    if path.stat().st_size>2*1024*1024:bad.append((name,'large_generated_file'));continue
    if any(part in {'node_modules','.venv','__pycache__','state','work','dist'} for part in path.relative_to(root).parts):bad.append((name,'runtime_directory'));continue
    try:text=path.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        bad.append((name,'unexpected_binary'));continue
    # The audit rules themselves necessarily contain example match fragments.
    if name=='scripts/audit_source.py':continue
    for label,pattern in patterns.items():
        if re.search(pattern,text):bad.append((name,label))
if bad:
    for name,reason in bad:print(f'{name}: {reason}',file=sys.stderr)
    raise SystemExit(1)
print(f'Publication audit passed: {len(set(files)-{""})} source files.')
