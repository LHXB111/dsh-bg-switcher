#!/bin/bash
# ============================================================================
# dsh-bg-switcher 安装脚本
#   把插件装进 DSH 的 web profile：文件 + node_modules 软链 + package.json
#   依赖/bundles + pnpm-lock.yaml importer 条目。装完重启 Harness 生效。
#
#   bash install.sh                     # 装到 $DSH_HOME/profiles/web
#   DSH_HOME=~/other bash install.sh    # 换 DSH_HOME
# ============================================================================
set -euo pipefail

NAME="dsh-bg-switcher"
SRC="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
# profile：命令行参数 > DSH_DESKTOP_PROFILE > 自动挑（官方桌面端是 desktop，社区版是 web）
pick_profile() {
	if [ -n "${1:-}" ]; then echo "$1"; return; fi
	if [ -n "${DSH_DESKTOP_PROFILE:-}" ]; then echo "$DSH_DESKTOP_PROFILE"; return; fi
	if [ -f "$DSH_HOME_DIR/profiles/desktop/package.json" ]; then echo desktop; return; fi
	echo web
}
PROFILE="$(pick_profile "${1:-}")"
PDIR="$DSH_HOME_DIR/profiles/$PROFILE"
TARGET="$PDIR/.local-plugins/$NAME"
BACKUP=".bak-before-$NAME"

if [ ! -f "$PDIR/package.json" ]; then
	echo "✖ 找不到 profile：$PDIR" >&2
	echo "  先启动一次 DSH Desktop（会初始化 web profile），或用 DSH_HOME 指定正确的位置。" >&2
	exit 1
fi

# 自保：绝对不要在"已安装目录"里跑本脚本（会先把源目录 rm -rf 掉，等于自毁）
SELF="$(cd "$SRC" && pwd -P)"
TARGET_REAL="$(cd "$PDIR/.local-plugins/$NAME" 2>/dev/null && pwd -P || true)"
if [ -n "$TARGET_REAL" ] && [ "$SELF" = "$TARGET_REAL" ]; then
	echo "✖ 这个脚本正在已安装目录里运行（源 == 安装目标）。" >&2
	echo "  想改插件请直接改这里的 lib/ 与 assets/，改完重新加载界面/重启 Harness 即可；" >&2
	echo "  想重新安装请从插件源码目录（如工作区里的 dsh-bg-switcher/）运行 install.sh。" >&2
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

echo "==> 安装 $NAME → $PDIR"

# ① 备份用户配置（只备份一次，保留最原始的版本）
if [ ! -f "$PDIR/package.json$BACKUP" ]; then
	cp "$PDIR/package.json" "$PDIR/package.json$BACKUP"
	echo "    备份 package.json → package.json$BACKUP"
fi
if [ -f "$PDIR/pnpm-lock.yaml" ] && [ ! -f "$PDIR/pnpm-lock.yaml$BACKUP" ]; then
	cp "$PDIR/pnpm-lock.yaml" "$PDIR/pnpm-lock.yaml$BACKUP"
	echo "    备份 pnpm-lock.yaml → pnpm-lock.yaml$BACKUP"
fi

# ② 拷贝插件本体（不带测试与工具脚本）
rm -rf "$TARGET"
mkdir -p "$TARGET"
tar -C "$SRC" --exclude ./test --exclude ./tools --exclude ./node_modules --exclude ./.git -cf - . |
	tar -C "$TARGET" -xf -
echo "    插件文件 → $TARGET"

# ③ node_modules 软链（Node 按目录名解析包名）
mkdir -p "$PDIR/node_modules"
ln -sfn "../.local-plugins/$NAME" "$PDIR/node_modules/$NAME"
echo "    软链 → node_modules/$NAME"

# ④ profile package.json：加依赖 + 放进 bundles（bundles 才等于"启用"）
"$NODE_BIN" -e '
const fs = require("node:fs");
const [file, name] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dependencies = { ...(manifest.dependencies ?? {}), [name]: `link:.local-plugins/${name}` };
const bundles = manifest.dsh?.profile?.bundles ?? [];
manifest.dsh = {
  ...manifest.dsh,
  profile: { ...manifest.dsh?.profile, bundles: bundles.includes(name) ? bundles : [...bundles, name] },
};
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
console.log("    bundles:", manifest.dsh.profile.bundles.join(", "));
' "$PDIR/package.json" "$NAME"

# ⑤ pnpm-lock.yaml：补 importer 条目（避免下次 pnpm install 认为依赖对不上）
if [ -f "$PDIR/pnpm-lock.yaml" ]; then
	"$NODE_BIN" -e '
const fs = require("node:fs");
const [file, name] = process.argv.slice(1);
const text = fs.readFileSync(file, "utf8");
if (text.includes(`link:.local-plugins/${name}`)) {
  console.log("    pnpm-lock.yaml 已有条目，跳过");
  process.exit(0);
}
const lines = text.split("\n");
const at = lines.findIndex((line) => line === "    dependencies:");
if (at === -1) {
  console.log("    pnpm-lock.yaml 结构不认识，跳过（不影响启动）");
  process.exit(0);
}
lines.splice(at + 1, 0,
  `      ${name}:`,
  `        specifier: link:.local-plugins/${name}`,
  `        version: link:.local-plugins/${name}`);
fs.writeFileSync(file, lines.join("\n"));
console.log("    pnpm-lock.yaml 已补 importer 条目");
' "$PDIR/pnpm-lock.yaml" "$NAME"
fi

# ⑥ 自检：装完的模块能被 import
"$NODE_BIN" --input-type=module -e "
const mod = await import('file://$TARGET/lib/index.js');
if (mod.name !== '$NAME' || typeof mod.apply !== 'function') throw new Error('导出形状不对');
console.log('    自检通过：' + mod.name + ' 可导入，apply 是函数');
"

echo
echo "✔ 已安装。接下来："
echo "  · 重启 Harness 让它重新收集插件行：官方桌面端直接退出并重开应用；社区版可在「插件」页点『立即重启』"
echo "  · 重启后界面右侧中部会出现一个背景图按钮（快捷键 Ctrl/⌘+Shift+B）"
echo "  · 图库目录：$PDIR/data/$NAME/backgrounds（面板里的「图库」按钮可直接打开）"
echo "  · 卸载：bash uninstall.sh"
