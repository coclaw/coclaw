#!/bin/bash
# 下载 node-datachannel 各平台预编译 binary
# 用法：bash scripts/download-ndc-prebuilds.sh
# 需要 curl 和 tar

set -euo pipefail

# 必须与 package.json 中 "node-datachannel" 版本严格一致
VERSION="0.32.2"
BASE_URL="https://github.com/murat-dogan/node-datachannel/releases/download/v${VERSION}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${SCRIPT_DIR}/../vendor/ndc-prebuilds"

PLATFORMS=(
	"linux-x64"
	"linux-arm64"
	"darwin-x64"
	"darwin-arm64"
	"win32-x64"
)

echo "Downloading node-datachannel v${VERSION} prebuilds..."

for plat in "${PLATFORMS[@]}"; do
	url="${BASE_URL}/node-datachannel-v${VERSION}-napi-v8-${plat}.tar.gz"
	dir="${DEST}/${plat}"
	mkdir -p "${dir}"
	echo "  ${plat}..."
	# tarball 内路径为 build/Release/node_datachannel.node，strip 2 层
	curl -sL "${url}" | tar xz -C "${dir}" --strip-components=2
	if [ ! -f "${dir}/node_datachannel.node" ]; then
		echo "  ERROR: ${dir}/node_datachannel.node not found after extraction"
		exit 1
	fi
done

echo ""
echo "All prebuilds downloaded to ${DEST}/"
ls -lh "${DEST}"/*/node_datachannel.node
