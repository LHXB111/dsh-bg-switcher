#!/bin/bash
# ============================================================================
# 真实环境验收：对着"正在运行的 DSH Desktop"（Harness 打印在日志里的那个 URL）
# 逐条 curl 一遍插件接口。只发 GET/PUT，不动任何会话数据。
#
#   bash tools/verify-live.sh
#   DSH_DESKTOP_LOG=/path/to/desktop.log bash tools/verify-live.sh
# ============================================================================
set -uo pipefail

LOG="${DSH_DESKTOP_LOG:-$HOME/Library/Application Support/dsh-desktop/logs/desktop.log}"
TMP="${VERIFY_TMP:-/tmp/dsh-bg-live}"
JAR="$TMP/cookies.txt"

pass=0
fail=0
check() {
	if [ "$2" -eq 0 ]; then
		echo "  ✔ $1"
		pass=$((pass + 1))
	else
		echo "  ✖ $1"
		fail=$((fail + 1))
	fi
}

[ -f "$LOG" ] || { echo "✖ 找不到桌面日志：$LOG" >&2; exit 1; }
rm -rf "$TMP" && mkdir -p "$TMP"

URL="$(grep -o 'dsh web: http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$LOG" | tail -1 | sed 's/^dsh web: //')"
[ -n "$URL" ] || { echo "✖ 日志里没有 Harness URL（Harness 起来过吗？）" >&2; exit 1; }
BASE="${URL%%\?*}"
BASE="${BASE%/}"   # 去掉结尾斜杠：curl "$BASE/path" 否则会变成 //path，被 URL 解析成 authority
echo "== Harness: $BASE =="

curl -s -c "$JAR" -b "$JAR" -L "$URL" -o "$TMP/index.html" -w "  首页 %{http_code} %{size_download}B\n"

echo "== 注入 =="
grep -q "dsh-bg/widget.js" "$TMP/index.html"
check "index.html 注入了 /dsh-bg/widget.js" $?
grep -q "__DSH_BG_INITIAL__" "$TMP/index.html"
check "index.html 带了设置快照 __DSH_BG_INITIAL__" $?

echo "== 接口 =="
code="$(curl -s -b "$JAR" -o "$TMP/widget.js" -w '%{http_code}' "$BASE/dsh-bg/widget.js")"
[ "$code" = "200" ] && grep -q "__dshBgSwitcher" "$TMP/widget.js"
check "GET /dsh-bg/widget.js → $code（脚本可下载）" $?

curl -s -b "$JAR" "$BASE/dsh-bg/list" -o "$TMP/list.json"
node -e '
const data = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const builtin = (data.items ?? []).filter((item) => item.source === "builtin");
if (!data.ok || builtin.length < 2) process.exit(1);
const names = builtin.map((item) => `${item.name} ${item.width}x${item.height}`);
if (!names.includes("教室自习 1072x758") || !names.includes("校舍走廊 1735x1227")) process.exit(2);
console.log("    图库：" + data.items.map((i) => i.id).join(", "));
' "$TMP/list.json"
check "GET /dsh-bg/list 返回内置图且尺寸正确" $?

curl -s -b "$JAR" -o "$TMP/bg.jpg" -w '%{http_code} %{content_type} %{size_download}' \
	"$BASE/dsh-bg/img?id=builtin%3A%E6%95%99%E5%AE%A4%E8%87%AA%E4%B9%A0.jpg" >"$TMP/img.txt"
grep -q "^200 image/jpeg 130526$" "$TMP/img.txt"
check "GET /dsh-bg/img 原图字节（$(cat "$TMP/img.txt")）" $?

curl -s -b "$JAR" -o "$TMP/thumb.jpg" -w '%{http_code} %{content_type}' \
	"$BASE/dsh-bg/thumb?id=builtin%3A%E6%A0%A1%E8%88%8D%E8%B5%B0%E5%BB%8A.png" >"$TMP/thumb.txt"
grep -q "^200 image/jpeg$" "$TMP/thumb.txt"
check "GET /dsh-bg/thumb 缩略图（$(cat "$TMP/thumb.txt")，$(wc -c <"$TMP/thumb.jpg" | tr -d ' ') 字节）" $?

curl -s -b "$JAR" -o /dev/null -w '%{http_code}' \
	"$BASE/dsh-bg/img?id=..%2F..%2Fetc%2Fpasswd" >"$TMP/traversal.txt"
grep -q "^404$" "$TMP/traversal.txt"
check "越界 id 被拒（$(cat "$TMP/traversal.txt")）" $?

echo "== 设置读写 =="
PUT_OK="$(curl -s -b "$JAR" -X PUT -H 'content-type: application/json' \
	-d '{"settings":{"dim":41,"mode":"contain"}}' "$BASE/dsh-bg/settings" |
	node -e 'let raw="";process.stdin.on("data",(c)=>raw+=c).on("end",()=>{const s=JSON.parse(raw).settings;process.stdout.write(s.dim===41&&s.mode==="contain"?"yes":"no")})')"
[ "$PUT_OK" = "yes" ]
check "PUT /dsh-bg/settings 接受并回读一致" $?

echo
if [ "$fail" -eq 0 ]; then
	echo "== 全部通过：$pass 项 =="
else
	echo "== $pass 通过 / $fail 失败 =="
	echo "--- 诊断 ---"
	echo "  /dsh-bg/list 状态：$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/dsh-bg/list")"
	echo "  对照 /dsh-whale/widget.js：$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/dsh-whale/widget.js")"
	echo "  插件是否在已启用列表：$(grep -c 'dsh-bg-switcher' "$HOME/.dsh/profiles/web/package.json")"
	echo "  提示：给 Harness 加 DSH_BG_TRACE=/tmp/bg.log 重启，可看到 apply/路由补齐到哪一步。"
fi
exit "$fail"
