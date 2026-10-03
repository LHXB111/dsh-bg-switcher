#!/bin/bash
# ============================================================================
# 官方版桌面端验收：插件装在 ~/.dsh/profiles/desktop，宿主 HTTP 默认在 127.0.0.1:19387。
# 检查三件事：
#   ① 宿主半区有没有加载（/dsh-bg/* 路由）
#   ② 页面半区有没有跑起来、壁纸有没有真的贴上（读插件回报的 diag.json）
#   ③ 遮罩有没有被"盖死"（settings.json 里的 dim）
#
#   bash tools/verify-official.sh
#   DSH_HOME=/path/to/.dsh bash tools/verify-official.sh
# ============================================================================
set -uo pipefail

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME_DIR/profiles/desktop}"
DATA="$PROFILE_DIR/data/dsh-bg-switcher"
BASE="${DSH_WEB_URL:-http://127.0.0.1:19387}"
NODE_BIN="${DSH_BG_NODE:-}"
if [ -z "$NODE_BIN" ]; then
	if command -v node >/dev/null 2>&1; then
		NODE_BIN="$(command -v node)"
	elif [ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node" ]; then
		NODE_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
		: "${DSH_DESKTOP_NODE_EXECUTABLE:=/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness}"
		export DSH_DESKTOP_NODE_EXECUTABLE
	fi
fi

pass=0
fail=0
check() {
	if [ "$2" -eq 0 ]; then echo "  ✔ $1"; pass=$((pass + 1)); else echo "  ✖ $1"; fail=$((fail + 1)); fi
}

echo "== 目标 =="
echo "   profile: $PROFILE_DIR"
echo "   harness: $BASE"
echo "   bundles: $("$NODE_BIN" -e '
const fs = require("node:fs");
try {
  const m = JSON.parse(fs.readFileSync(process.argv[1] + "/package.json", "utf8"));
  process.stdout.write((m.dsh?.profile?.bundles ?? []).join(", "));
} catch { process.stdout.write("(读不到 package.json)"); }
' "$PROFILE_DIR")"

echo "== ① 宿主半区 =="
curl -s -m 8 "$BASE/dsh-bg/list" -o /tmp/dsh-bg-list.json
"$NODE_BIN" -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync("/tmp/dsh-bg-list.json", "utf8"));
const builtin = (data.items ?? []).filter((item) => item.source === "builtin");
if (!data.ok || builtin.length === 0) process.exit(1);
console.log("    图库：" + data.items.map((i) => i.id).join(", "));
console.log("    设置：activeId=" + String(data.settings.activeId) + " dim=" + String(data.settings.dim) + " mode=" + String(data.settings.mode));
' 2>/dev/null
check "GET /dsh-bg/list 有内置图" $?

for path in /dsh-bg/widget.js /dsh-bg/thumb?id=builtin%3A%E6%95%99%E5%AE%A4%E8%87%AA%E4%B9%A0.jpg; do
	code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE$path")"
	[ "$code" = "200" ]
	check "GET $path → $code" $?
done

echo "== ② 页面半区（看插件的自检回报）=="
if [ -f "$DATA/diag.json" ]; then
	"$NODE_BIN" -e '
const fs = require("node:fs");
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const d = raw.payload || {};
const w = d.widget || {};
const b = d.body || {};
const ok = (label, v) => console.log(`  ${v ? "✔" : "✖"} ${label}`);
console.log("    回报时间：" + String(raw.at) + "（reason=" + String(d.reason) + "）");
ok("widget 已就绪", w.ready);
ok("body 上有 data-dsh-bg（壁纸已生效）", (b.attrs || []).includes("data-dsh-bg"));
ok("body 计算样式里带背景图 URL", /dsh-bg\/img/.test(String((b.computed || {}).bgImage)));
ok("图库网格有卡片", (w.cards || 0) > 0);
const probe = d.imageProbe || {};
ok("背景图能取到（异步探针）", probe.ok === true && (probe.bytes || [0])[0] > 0);
if (b.vars) console.log("    遮罩=" + String(b.vars.scrim) + " 模糊=" + String(b.vars.blur) + " 基址=" + String((d.api || {}).base));
if (probe.src) console.log("    背景图：" + String(probe.src).slice(0, 90) + " → " + JSON.stringify(probe.bytes || []) + " 耗时 " + String(probe.ms || "?") + "ms");
if (d.error) console.log("    diag 采集异常：" + d.error);
' "$DATA/diag.json"
else
	echo "  ⚠ 还没有 diag.json：页面上还没跑起插件的浏览器半区（重新加载界面后就会回报）"
fi

echo "== ③ 遮罩检查 =="
if [ -f "$DATA/settings.json" ]; then
	dim="$("$NODE_BIN" -e 'try{process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).dim))}catch{process.stdout.write("?")}' "$DATA/settings.json")"
	echo "    当前遮罩：${dim}%"
	if [ "$dim" = "?" ]; then
		check "settings.json 可解析" 1
	elif [ "$dim" -ge 95 ] 2>/dev/null; then
		echo "  ⚠ 遮罩 ≥95%：壁纸会被完全盖住（插件会在下次加载界面时自动调到 45% 并落盘）"
		check "遮罩未把壁纸盖死" 1
	else
		check "遮罩未把壁纸盖死" 0
	fi
else
	echo "  ⚠ 还没有 settings.json（插件还没在页面上跑过）"
fi

echo
echo "== 结果：$pass 通过 / $fail 失败 =="
exit "$fail"
