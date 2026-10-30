#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/.." && pwd)
engine=${CONTAINER_ENGINE:-podman}
output=${1:-"$repo/dist/rootfs.tar"}
mkdir -p -- "$(dirname -- "$output")"
"$engine" build --network "${BUILD_NETWORK:-bridge}" --tag localhost/starport-pi:tw-v1 --file "$repo/server/Dockerfile" "$repo"
container=$("$engine" create localhost/starport-pi:tw-v1)
trap '"$engine" rm "$container" >/dev/null' EXIT
"$engine" export --output "$output" "$container"
(cd -- "$(dirname -- "$output")" && sha256sum -- "$(basename -- "$output")") > "$output.sha256"
printf 'Root filesystem and SHA-256 receipt created.\n'
