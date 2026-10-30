param([string]$Distribution = 'Ubuntu-24.04', [switch]$Configure)
$ErrorActionPreference = 'Stop'
if ($Distribution -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Invalid distribution name.' }
if (-not $Configure) {
    wsl.exe --install --distribution $Distribution --no-launch
    if ($LASTEXITCODE -ne 0) { throw 'WSL installation did not complete. Check Windows virtualization requirements.' }
    Write-Host "If Windows requests a restart, restart it yourself. Launch $Distribution once to create its Linux user."
    Write-Host "Then run this script with -Distribution $Distribution -Configure."
    exit
}
$Script = @'
set -eu
apt-get update -o APT::Update::Error-Mode=any
apt-get install -y python3 python3-venv git curl ca-certificates xz-utils locales tzdata fonts-noto-cjk fontconfig
localedef -i zh_TW -f UTF-8 zh_TW.UTF-8
ln -snf /usr/share/zoneinfo/Asia/Taipei /etc/localtime
printf 'Asia/Taipei\n' > /etc/timezone
printf 'LANG=zh_TW.UTF-8\nLC_ALL=zh_TW.UTF-8\n' > /etc/default/locale
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=19?0:1)" 2>/dev/null; then
  node_version=$(python3 -c 'import json,urllib.request; print(next(v["version"] for v in json.load(urllib.request.urlopen("https://nodejs.org/dist/index.json",timeout=30)) if v["version"].startswith("v22.")))')
  case "$(uname -m)" in x86_64) node_arch=x64;; aarch64) node_arch=arm64;; *) exit 1;; esac
  task_dir=$(mktemp -d);trap 'rm -rf "$task_dir"' EXIT
  cd "$task_dir"
  node_archive="node-$node_version-linux-$node_arch.tar.xz"
  curl --fail --location --proto '=https' --tlsv1.2 -O "https://nodejs.org/dist/$node_version/$node_archive"
  curl --fail --location --proto '=https' --tlsv1.2 -O "https://nodejs.org/dist/$node_version/SHASUMS256.txt"
  awk -v name="$node_archive" '$2 == name {print}' SHASUMS256.txt > selected.sha256
  test -s selected.sha256;sha256sum -c selected.sha256
  mkdir -p /opt/starport-node
  tar -xf "$node_archive" -C /opt/starport-node --strip-components=1
  printf 'export PATH=/opt/starport-node/bin:$PATH\n' > /etc/profile.d/starport-node.sh
fi
printf 'Open a new Ubuntu terminal, then run scripts/install.sh from your Linux checkout.\n'
printf 'WSL is an optional client host. All model commands must still execute on the remote worker.\n'
'@
$Script | wsl.exe --distribution $Distribution --user root -- bash -s
if ($LASTEXITCODE -ne 0) { throw 'WSL configuration failed.' }
