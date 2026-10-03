#!/bin/bash
# ============================================================================
# 渲染探针：用**官方版** 0.2.0-rc.2 的 harness + 官方前端 dist，在临时 profile 里
# 起一个一次性实例，然后用 headless Chrome 真的把页面渲染出来：
#   · --dump-dom  看注入行有没有生效、body 上有没有 data-dsh-bg
#   · --screenshot 存一张 1440x900 的截图，肉眼确认壁纸到底出没出来
# 不碰用户的真实 profile（配置只读复制，插件本体复制一份到临时 profile）。
#
#   bash tools/probe-render.sh
# ============================================================================
set -uo pipefail

APP="/Applications/DeepSeek Harness.app"
N="$APP/Contents/Resources/runtime/bin/node"
ENTRY="$APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
REAL_PROFILE="${REAL_PROFILE:-$HOME/.dsh/profiles/desktop}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
export DSH_DESKTOP_NODE_EXECUTABLE="$APP/Contents/MacOS/DeepSeek Harness"
TMP="${PROBE_HOME:-/tmp/dsh-bg-probe}"
# 官方版把 desktop profile 保留给 Electron 应用自身，探针用独立的 profile 名
PROFILE_NAME="${PROBE_PROFILE:-probe}"
LOG="$TMP/harness.log"

cleanup() {
	if [ -n "${HARNESS_PID:-}" ] && kill -0 "$HARNESS_PID" 2>/dev/null; then
		kill "$HARNESS_PID" 2>/dev/null
		wait "$HARNESS_PID" 2>/dev/null
	fi
}
trap cleanup EXIT

[ -x "$N" ] || { echo "✖ 找不到官方 runtime node：$N" >&2; exit 1; }
[ -x "$CHROME" ] || { echo "✖ 找不到 Chrome：$CHROME" >&2; exit 1; }

echo "== 1. 搭临时 profile（复制官方 desktop profile 的配置与插件）=="
rm -rf "$TMP"
mkdir -p "$TMP/profiles/$PROFILE_NAME/node_modules" "$TMP/profiles/$PROFILE_NAME/.local-plugins"
cp "$REAL_PROFILE/package.json" "$TMP/profiles/$PROFILE_NAME/package.json"
cp "$REAL_PROFILE/cordis.patch.yml" "$TMP/profiles/$PROFILE_NAME/cordis.patch.yml"
# 只把 desktop profile 自己的插件依赖软链过去，官方内置包走 app.asar 自己的解析
for entry in "$REAL_PROFILE/node_modules/"*; do
	name="$(basename "$entry")"
	case "$name" in
		@deepseek-ai|.bin|.pnpm|.modules.yaml|.package-map.json) continue ;;
	esac
	ln -sfn "$entry" "$TMP/profiles/$PROFILE_NAME/node_modules/$name"
done
mkdir -p "$TMP/profiles/$PROFILE_NAME/node_modules/@deepseek-ai"
for entry in "$REAL_PROFILE/node_modules/@deepseek-ai/"*; do
	[ -e "$entry" ] || continue
	ln -sfn "$entry" "$TMP/profiles/$PROFILE_NAME/node_modules/@deepseek-ai/$(basename "$entry")"
done
cp -R "$SRC" "$TMP/profiles/$PROFILE_NAME/.local-plugins/dsh-bg-switcher"
rm -rf "$TMP/profiles/$PROFILE_NAME/.local-plugins/dsh-bg-switcher/test" "$TMP/profiles/$PROFILE_NAME/.local-plugins/dsh-bg-switcher/tools"
ln -sfn ../.local-plugins/dsh-bg-switcher "$TMP/profiles/$PROFILE_NAME/node_modules/dsh-bg-switcher"
# 真实 profile 里插件可能被插件管理器摘出了 bundles：探针强制放回去，保证探的是插件本身
"$N" -e '
const fs = require("node:fs");
const file = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const bundles = manifest.dsh?.profile?.bundles ?? [];
if (!bundles.includes("dsh-bg-switcher")) {
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, "dsh-bg-switcher"] } };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  console.log("   已把 dsh-bg-switcher 放回 bundles（真实 profile 里当前缺少）");
}
' "$TMP/profiles/$PROFILE_NAME/package.json"
# 探针用自己的设置（默认遮罩 30 / 模糊 0 / 填充）：避免把"用户把遮罩拉满"的状态当成代码 bug
mkdir -p "$TMP/profiles/$PROFILE_NAME/data/dsh-bg-switcher"
DEFAULT_PROBE_SETTINGS='{"activeId":"builtin:教室自习.jpg","lightId":null,"darkId":null,"split":false,"immersive":true,"hidden":false,"mode":"cover","dim":30,"blur":0,"btnX":0,"btnY":0}'
PROBE_SETTINGS="${PROBE_SETTINGS:-$DEFAULT_PROBE_SETTINGS}"
printf '%s' "$PROBE_SETTINGS" >"$TMP/profiles/$PROFILE_NAME/data/dsh-bg-switcher/settings.json"
"$N" -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' \
	"$TMP/profiles/$PROFILE_NAME/data/dsh-bg-switcher/settings.json" ||
	{ echo "✖ PROBE_SETTINGS 不是合法 JSON：$PROBE_SETTINGS" >&2; exit 1; }
echo "   profile: $TMP/profiles/$PROFILE_NAME"
echo "   写完设置立刻读回: $(cat "$TMP/profiles/$PROFILE_NAME/data/dsh-bg-switcher/settings.json")  (mtime $(stat -f %Sm "$TMP/profiles/$PROFILE_NAME/data/dsh-bg-switcher/settings.json"))"
echo "   探针设置: $PROBE_SETTINGS"
echo "   用户真实设置: $(cat "$REAL_PROFILE/data/dsh-bg-switcher/settings.json" 2>/dev/null | tr -d '\n\t' | head -c 220)"

echo "== 2. 起一次性官方 harness（随机端口）=="
(
	cd "$HOME" || exit 1
	# 会话里带着真实 profile 的 DSH_PROFILE_DIR：探针必须清掉，否则插件会读写用户的真实数据目录
	unset DSH_PROFILE_DIR DSH_PROFILE DSH_WEB_URL DSH_SESSION_ID
	export DSH_HOME="$TMP" DSH_DESKTOP_PROFILE=$PROFILE_NAME NO_COLOR=1 FORCE_COLOR=0
	export DSH_BG_TRACE="$TMP/trace.log"
	export DSH_DESKTOP_NODE_EXECUTABLE="$APP/Contents/MacOS/DeepSeek Harness"
	exec "$N" "$ENTRY" --profile "$PROFILE_NAME" --port 0 --no-open >"$LOG" 2>&1
) &
HARNESS_PID=$!

URL=""
for _ in $(seq 1 90); do
	URL="$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$LOG" | tail -1)"
	[ -n "$URL" ] && break
	kill -0 "$HARNESS_PID" 2>/dev/null || break
	sleep 1
done
if [ -z "$URL" ]; then
	echo "  ✖ harness 没起来，日志尾部："
	tail -25 "$LOG" | sed 's/^/    /'
	exit 1
fi
BASE="${URL%%\?*}"
BASE="${BASE%/}"
echo "   ready: $BASE"
# 顺便核一遍插件接口
echo "   harness 起来后设置文件: $(cat "$TMP/profiles/$PROFILE_NAME/data/dsh-bg-switcher/settings.json")  (mtime $(stat -f %Sm "$TMP/profiles/$PROFILE_NAME/data/dsh-bg-switcher/settings.json"))"
for p in /dsh-bg/list /dsh-bg/widget.js; do
	printf "   %-20s -> %s\n" "$p" "$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$BASE$p")"
done

echo "== 3. headless Chrome + CDP 抓页面真实状态 =="
CHROME_PORT="${CHROME_PORT:-9223}"
"$CHROME" --headless=new --no-sandbox --disable-gpu --disable-gpu-sandbox \
	--disable-breakpad --disable-crash-reporter --no-first-run --no-default-browser-check \
	--user-data-dir="$TMP/chrome" --crash-dumps-dir="$TMP/crash" \
	--remote-debugging-port="$CHROME_PORT" --window-size=1440,900 --hide-scrollbars \
	about:blank >"$TMP/chrome.out" 2>"$TMP/chrome.err" &
CHROME_PID=$!
trap 'kill "$CHROME_PID" 2>/dev/null; cleanup' EXIT

"$N" "$SRC/tools/cdp-probe.mjs" "$URL" "$TMP" "$CHROME_PORT" 12000
PROBE_STATUS=$?
kill "$CHROME_PID" 2>/dev/null
echo "    diag: $TMP/diag.json / 截图: $TMP/shot.png"

echo "== 4. 结论 =="
"$N" -e '
const fs = require("node:fs");
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const d = raw.diag || {};
const ok = (label, value) => console.log(`  ${value ? "✔" : "✖"} ${label}`);
const probe = d.imageProbe || {};
ok("widget 脚本跑起来了（window.__dshBgSwitcher.ready）", d.widget && d.widget.ready);
ok("body 上有 data-dsh-bg", d.body && d.body.attrs.includes("data-dsh-bg"));
ok("舞台层上挂着背景图 URL", Array.isArray(d.stage) && d.stage.some((slide) => slide.hasImage));
ok("内联样式表已挂载", d.widget && d.widget.style);
ok("面板 DOM 存在", d.widget && d.widget.panel);
ok("图库网格有卡片", d.widget && d.widget.cards > 0);
ok("缩略图真的加载成功", d.widget && d.widget.thumbsLoaded.some((t) => t.w > 0));
ok("背景图能取到（Image 探针）", probe.ok === true && (probe.bytes || [0])[0] > 0);
ok("舞台双层存在", Array.isArray(d.stage) && d.stage.length === 2);
ok("两层里有一层正显示壁纸", Array.isArray(d.stage) && d.stage.some((slide) => slide.hasImage && Number(slide.opacity) > 0.9));
ok("轮播字段可读（含倒计时）", Boolean(d.rotateInfo) && Number.isFinite(d.rotateInfo.minutes));
ok("视差字段可读", Boolean(d.parallax) && d.parallax.on !== undefined);
console.log("  —— 关键数值 ——");
console.log("   body.attrs       :", (d.body?.attrs || []).join(","));
console.log("   body 底色         :", d.body?.computed?.bgColor, "（图在舞台层里）");
console.log("   token bg-base    :", d.body?.tokens?.base, "| root:", d.root?.computed?.tokenBase);
console.log("   root 尺寸/背景    :", JSON.stringify(d.root?.rect), d.root?.computed?.bg);
console.log("   widget           :", JSON.stringify(d.widget && { cards: d.widget.cards, items: d.widget.items, active: d.widget.activeId, status: d.widget.status }));
console.log("   中心点元素栈      :");
for (const s of d.stack || []) console.log("     ", JSON.stringify(s));
console.log("   imageProbe       :", JSON.stringify(d.imageProbe));
console.log("   舞台/轮播/视差    :", JSON.stringify({ stage: d.stage, index: d.stageInfo && d.stageInfo.index, currentId: d.stageInfo && d.stageInfo.currentId, rotate: d.rotateInfo, parallax: d.parallax }));
if (d.error) console.log("   diag error       :", d.error);
if ((raw.exceptions || []).length) console.log("   页面异常          :", JSON.stringify(raw.exceptions.slice(0, 3)));
if ((raw.console || []).length) console.log("   控制台尾部        :", JSON.stringify(raw.console.slice(-6)));
' "$TMP/diag.json"

echo
echo "产物：$TMP/shot.png（截图） / $TMP/dom.html（DOM） / $LOG（harness 日志）"
