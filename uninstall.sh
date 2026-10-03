#!/bin/bash
# ============================================================================
# dsh-bg-switcher 卸载脚本
#   从 web profile 摘掉插件（文件 / 软链 / 依赖 / bundles / lock 条目）。
#   默认保留图库与设置；加 --purge 一并删除 data/dsh-bg-switcher。
#
#   bash uninstall.sh
#   bash uninstall.sh --purge
# ============================================================================
set -euo pipefail

NAME="dsh-bg-switcher"
PURGE="no"
for arg in "$@"; do [ "$arg" = "--purge" ] && PURGE="yes"; done

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
if [ -n "${1:-}" ] && [ "${1#--}" = "$1" ]; then PROFILE="$1"; elif [ -n "${DSH_DESKTOP_PROFILE:-}" ]; then PROFILE="$DSH_DESKTOP_PROFILE"; elif [ -f "$DSH_HOME_DIR/profiles/desktop/package.json" ]; then PROFILE=desktop; else PROFILE=web; fi
PDIR="$DSH_HOME_DIR/profiles/$PROFILE"

if [ ! -f "$PDIR/package.json" ]; then
	echo "✖ 找不到 profile：$PDIR" >&2
	exit 1
fi

# ── 找一个能用的 node：官方桌面端把 node 从 PATH 里拿掉了，只有 runtime/bin/node 垫片 ──
resolve_node() {
	if [ -n "${DSH_BG_NODE:-}" ] && [ -x "${DSH_BG_NODE}" ]; then echo "$DSH_BG_NODE"; return; fi
	if command -v node >/dev/null 2>&1; then command -v node; return; fi
	local shim="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
	if [ -x "$shim" ]; then echo "$shim"; return; fi
	echo ""
}
NODE_BIN="$(resolve_node)"
# 官方 runtime 的 node 是个垫片：真正执行的是 $DSH_DESKTOP_NODE_EXECUTABLE
if [ "$NODE_BIN" = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node" ]; then
	: "${DSH_DESKTOP_NODE_EXECUTABLE:=/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness}"
	export DSH_DESKTOP_NODE_EXECUTABLE
fi
if [ -z "$NODE_BIN" ]; then
	echo "✖ 找不到可用的 node（可设 DSH_BG_NODE=<node 路径>）" >&2
	exit 1
fi

echo "==> 卸载 $NAME ← $PDIR"

"$NODE_BIN" -e '
const fs = require("node:fs");
const [file, name] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
if (manifest.dependencies) delete manifest.dependencies[name];
const bundles = manifest.dsh?.profile?.bundles ?? [];
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.filter((entry) => entry !== name) } };
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
console.log("    已从 dependencies / bundles 移除");
' "$PDIR/package.json" "$NAME"

if [ -f "$PDIR/pnpm-lock.yaml" ]; then
	"$NODE_BIN" -e '
const fs = require("node:fs");
const [file, name] = process.argv.slice(1);
const lines = fs.readFileSync(file, "utf8").split("\n");
const kept = [];
let skipping = false;
for (const line of lines) {
  if (line.trim() === `${name}:` || line.trim() === `"${name}":`) { skipping = true; continue; }
  if (skipping) {
    if (/^ {8}(specifier|version):/.test(line)) continue;
    skipping = false;
  }
  kept.push(line);
}
fs.writeFileSync(file, kept.join("\n"));
console.log("    已清理 pnpm-lock.yaml 条目");
' "$PDIR/pnpm-lock.yaml" "$NAME"
fi

rm -f "$PDIR/node_modules/$NAME"
rm -rf "$PDIR/.local-plugins/$NAME"
echo "    已删除插件文件与 node_modules 软链"

if [ "$PURGE" = "yes" ]; then
	rm -rf "$PDIR/data/$NAME"
	echo "    已删除图库与设置（data/$NAME）"
else
	echo "    图库与设置保留在：$PDIR/data/$NAME"
fi

echo
echo "✔ 已卸载。重启 Harness（或 DSH Desktop）后生效。"
echo "  想恢复安装前的 profile 配置："
echo "    cp \"$PDIR/package.json.bak-before-$NAME\" \"$PDIR/package.json\""
