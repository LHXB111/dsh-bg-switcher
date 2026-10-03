#!/bin/bash
# ============================================================================
# 沙盒验收：用临时 DSH_HOME 起一个一次性的 dsh web（随机端口），把插件真正装载起来，
# 然后从外面 curl 一遍 —— 验证 bundle patch → 插件路由 → index 注入 → 图库接口。
# 不动真实 profile 的任何配置（只把 node_modules / 皮肤包软链过去复用依赖）。
#
#   bash tools/verify-sandbox.sh
# ============================================================================
set -uo pipefail

APP="/Applications/DSH Desktop.app/Contents/Resources/app"
ENTRY="$APP/node_modules/@deepseek-ai/dsh/lib/bin.js"
PATCH="$APP/src/dsh-desktop.patch.yml"
REAL_HOME="${DSH_HOME:-$HOME/.dsh}"
REAL_PROFILE="$REAL_HOME/profiles/web"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="${VERIFY_HOME:-/tmp/dsh-bg-verify}"
LOG="$TMP/harness.log"
JAR="$TMP/cookies.txt"

pass=0
fail=0
check() { # check <描述> <条件表达式结果 0/1>
	if [ "$2" -eq 0 ]; then
		echo "  ✔ $1"
		pass=$((pass + 1))
	else
		echo "  ✖ $1"
		fail=$((fail + 1))
	fi
}

cleanup() {
	if [ -n "${HARNESS_PID:-}" ] && kill -0 "$HARNESS_PID" 2>/dev/null; then
		kill "$HARNESS_PID" 2>/dev/null
		wait "$HARNESS_PID" 2>/dev/null
	fi
}
trap cleanup EXIT

echo "== 1. 搭临时 profile =="
rm -rf "$TMP"
mkdir -p "$TMP/profiles/web/.local-plugins"
mkdir -p "$TMP/profiles/web/node_modules"
cp "$REAL_PROFILE/package.json" "$TMP/profiles/web/package.json"
[ -f "$REAL_PROFILE/cordis.patch.yml" ] && cp "$REAL_PROFILE/cordis.patch.yml" "$TMP/profiles/web/cordis.patch.yml"
# 真实 profile 的 cordis.yml 是"物化后的完整行表"；不带上它，临时实例会退化成
# "只有 bundle patch" 的另一种组合（会出现两个 webServer 实例），验证就不等价了。
[ -f "$REAL_PROFILE/cordis.yml" ] && cp "$REAL_PROFILE/cordis.yml" "$TMP/profiles/web/cordis.yml"
[ -d "$REAL_PROFILE/.local-plugins/dsh-client-ui-skin-denia" ] &&
	ln -s "$REAL_PROFILE/.local-plugins/dsh-client-ui-skin-denia" "$TMP/profiles/web/.local-plugins/dsh-client-ui-skin-denia"

# node_modules 必须是**真目录**：整体软链过去的话，往里加包会写穿到真实 profile。
shopt -s dotglob nullglob
for entry in "$REAL_PROFILE/node_modules/"*; do
	ln -s "$entry" "$TMP/profiles/web/node_modules/$(basename "$entry")"
done
shopt -u dotglob nullglob

# 被测插件：拷进临时 profile 的 .local-plugins，并挂到 node_modules 下（与正式安装同构）
mkdir -p "$TMP/profiles/web/.local-plugins/dsh-bg-switcher"
tar -C "$SRC" --exclude ./test --exclude ./tools --exclude ./node_modules --exclude ./.git -cf - . |
	tar -C "$TMP/profiles/web/.local-plugins/dsh-bg-switcher" -xf -
ln -s ../.local-plugins/dsh-bg-switcher "$TMP/profiles/web/node_modules/dsh-bg-switcher"

node -e '
const fs = require("fs");
const file = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dependencies = { ...(manifest.dependencies || {}), "dsh-bg-switcher": "link:.local-plugins/dsh-bg-switcher" };
const bundles = manifest.dsh?.profile?.bundles || [];
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.includes("dsh-bg-switcher") ? bundles : [...bundles, "dsh-bg-switcher"] } };
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
console.log("  bundles:", manifest.dsh.profile.bundles.join(", "));
' "$TMP/profiles/web/package.json"
echo "  profile: $TMP/profiles/web"

echo "== 2. 起一次性 harness（随机端口）=="
(
	# 桌面端就是以用户 home 为 cwd 起 harness 的，照抄这个条件
	cd "$HOME" || exit 1
	export DSH_HOME="$TMP" DSH_DESKTOP_PROFILE=web DSH_DESKTOP=1 NO_COLOR=1 FORCE_COLOR=0
	export DSH_BG_TRACE="$TMP/trace.log" ELECTRON_RUN_AS_NODE=1
	exec node --expose-internals "$ENTRY" web --patch "$PATCH" --port 0 --no-open >"$LOG" 2>&1
) &
HARNESS_PID=$!

URL=""
for _ in $(seq 1 90); do
	URL="$(sed -n 's/.*dsh web: \(http:\/\/127\.0\.0\.1:[0-9]*\/[^ ]*\).*/\1/p' "$LOG" | head -1)"
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
BASE="${BASE%/}"   # 去掉结尾斜杠：curl "$BASE/path" 否则会变成 //path，被 URL 解析成 authority
echo "  ready: $BASE"
# token 换 cookie
curl -s -c "$JAR" -b "$JAR" -L "$URL" -o "$TMP/index.html"

echo "== 3. 断言 =="
grep -q "dsh-bg/widget.js" "$TMP/index.html"
check "index.html 里注入了 /dsh-bg/widget.js" $?

grep -q "__DSH_BG_INITIAL__" "$TMP/index.html"
check "index.html 里带了设置快照 __DSH_BG_INITIAL__" $?

[ "$(curl -s -b "$JAR" -o "$TMP/widget.js" -w '%{http_code}' "$BASE/dsh-bg/widget.js")" = "200" ] &&
	grep -q "__dshBgSwitcher" "$TMP/widget.js"
check "GET /dsh-bg/widget.js 返回浏览器半区脚本" $?

curl -s -b "$JAR" "$BASE/dsh-bg/list" -o "$TMP/list.json"
node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const builtin = data.items.filter((i) => i.source === "builtin");
if (!data.ok || builtin.length !== 2) process.exit(1);
const names = builtin.map((i) => `${i.name} ${i.width}x${i.height}`).sort();
if (!names.includes("校舍走廊 1735x1227") || !names.includes("教室自习 1072x758")) process.exit(2);
console.log("    图库：" + names.join(" / "));
' "$TMP/list.json"
check "GET /dsh-bg/list 返回两张内置图且尺寸正确" $?

curl -s -b "$JAR" -o "$TMP/bg.jpg" -w '%{http_code} %{content_type} %{size_download}' \
	"$BASE/dsh-bg/img?id=builtin%3A%E6%95%99%E5%AE%A4%E8%87%AA%E4%B9%A0.jpg" >"$TMP/img.txt"
grep -q "^200 image/jpeg 130526$" "$TMP/img.txt"
check "GET /dsh-bg/img 返回原图字节（$(cat "$TMP/img.txt")）" $?

curl -s -b "$JAR" -o "$TMP/thumb.jpg" -w '%{http_code} %{content_type}' \
	"$BASE/dsh-bg/thumb?id=builtin%3A%E6%A0%A1%E8%88%8D%E8%B5%B0%E5%BB%8A.png" >"$TMP/thumb.txt"
grep -q "^200 image/jpeg$" "$TMP/thumb.txt"
check "GET /dsh-bg/thumb 出缩略图（$(cat "$TMP/thumb.txt")，$(wc -c <"$TMP/thumb.jpg" | tr -d ' ') 字节）" $?

curl -s -b "$JAR" -X PUT -H 'content-type: application/json' \
	-d '{"settings":{"activeId":"builtin:校舍走廊.png","dim":33,"mode":"contain"}}' \
	"$BASE/dsh-bg/settings" -o "$TMP/settings.json"
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).settings;
if (s.activeId !== "builtin:校舍走廊.png" || s.dim !== 33 || s.mode !== "contain") process.exit(1);
' "$TMP/settings.json"
check "PUT /dsh-bg/settings 落盘成功" $?

node -e '
const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (s.activeId !== "builtin:校舍走廊.png" || s.dim !== 33) process.exit(1);
' "$TMP/profiles/web/data/dsh-bg-switcher/settings.json"
check "settings.json 真的写在临时 profile 的 data 目录里" $?

echo
echo "== 诊断 =="
echo "  /dsh-whale/widget.js -> $(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/dsh-whale/widget.js")  （对照：已装插件的路由）"
echo "  dist 静态资源        -> $(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/assets/index-Cq6ljTv2.css")  （对照：frontend-static 是否在服务 dist）"
echo "  /dsh-bg/list         -> $(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/dsh-bg/list")"
echo "  /no-such-page        -> $(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/no-such-page")  body=[$(curl -s -b "$JAR" "$BASE/no-such-page" | head -c 40)]"
echo "  /dsh-bg/widget.js    -> $(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/dsh-bg/widget.js")"
echo "  /no-such-page (第2次) -> $(curl -s -b "$JAR" "$BASE/no-such-page" | head -c 40)"
if [ -f "$TMP/trace.log" ]; then
	echo "  --- trace ---"
	sed 's/^/  /' "$TMP/trace.log"
else
	echo "  （没有 trace.log：插件 apply() 根本没被调用）"
fi

echo
echo "== 结果：$pass 通过 / $fail 失败 =="
[ "$fail" -eq 0 ] || { echo "--- harness 日志尾部 ---"; tail -20 "$LOG"; }
exit "$fail"
