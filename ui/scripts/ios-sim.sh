#!/usr/bin/env bash
# CoClaw iOS 模拟器无签名工作流（无 Apple 凭据可用）：
#   ios-sim.sh build                 无签名构建模拟器包，产物 dist-ios/App.app
#   ios-sim.sh install [设备名...]   把 dist-ios/App.app 装到模拟设备，缺省装 DEFAULT_DEVICES
# 注意：重新 build 后需重跑 install；新建 / erase 过的设备也要补装。
set -euo pipefail
cd "$(dirname "$0")/.."

# 默认安装设备清单（按需追加；名字以 `xcrun simctl list devices available` 为准）
DEFAULT_DEVICES=("iPhone 17" "iPad Air 11-inch (M4)")

DERIVED_DATA=/tmp/coclaw-ios-build
APP_SRC="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/App.app"
APP_DEST=dist-ios/App.app

cmd_build() {
	# pnpm build 仅为满足 cap sync 对 webDir 的要求；app 运行时加载线上前端
	pnpm build
	npx cap sync ios
	# 关签名构建；不要换成 `npx cap run ios`（它倾向走签名流程）
	xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
		-sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
		-derivedDataPath "$DERIVED_DATA" CODE_SIGNING_ALLOWED=NO build
	# 拷到稳定产物位（/tmp 重启会被清）
	rm -rf "$APP_DEST"
	mkdir -p "$(dirname "$APP_DEST")"
	cp -R "$APP_SRC" "$APP_DEST"
	echo "Built: $PWD/$APP_DEST"
}

# 按设备名查可用设备，输出 "state<TAB>udid"；找不到输出空（设备名含括号，不宜文本 grep，用 JSON 解析）
device_info() {
	xcrun simctl list devices -j | node -e '
		let raw = "";
		process.stdin.on("data", (c) => raw += c).on("end", () => {
			const name = process.argv[1];
			for (const devs of Object.values(JSON.parse(raw).devices)) {
				for (const d of devs) {
					if (d.name === name && d.isAvailable) {
						console.log(`${d.state}\t${d.udid}`);
						return;
					}
				}
			}
		});
	' "$1"
}

cmd_install() {
	if [ ! -d "$APP_DEST" ]; then
		echo "Error: $APP_DEST not found, run \`pnpm ios:sim:build\` first" >&2
		exit 1
	fi
	devices=("$@")
	if [ ${#devices[@]} -eq 0 ]; then
		devices=("${DEFAULT_DEVICES[@]}")
	fi
	fail_count=0
	for name in "${devices[@]}"; do
		info=$(device_info "$name")
		if [ -z "$info" ]; then
			echo "[$name] Error: simulator device not found or unavailable" >&2
			fail_count=$((fail_count + 1))
			continue
		fi
		state=${info%%$'\t'*}
		udid=${info##*$'\t'}
		temp_boot=0
		if [ "$state" != "Booted" ]; then
			temp_boot=1
			echo "[$name] booting..."
		fi
		# bootstatus -b：未启动则拉起并等到就绪，已启动则立即返回
		if xcrun simctl bootstatus "$udid" -b >/dev/null \
			&& xcrun simctl install "$udid" "$APP_DEST"; then
			echo "[$name] installed"
		else
			echo "[$name] Error: install failed" >&2
			fail_count=$((fail_count + 1))
		fi
		# 只关脚本临时拉起的设备，原本就在跑的保持原状
		if [ "$temp_boot" = 1 ]; then
			xcrun simctl shutdown "$udid" >/dev/null || true
		fi
	done
	if [ "$fail_count" -gt 0 ]; then
		echo "Done with $fail_count failure(s)" >&2
		exit 1
	fi
	echo "Done: installed on ${#devices[@]} device(s)"
}

case "${1:-}" in
	build) cmd_build ;;
	install) shift; cmd_install "$@" ;;
	*)
		echo "Usage: $0 build | install [device name ...]" >&2
		exit 1
		;;
esac
