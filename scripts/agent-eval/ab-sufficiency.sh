#!/usr/bin/env bash
# 充分性 A/B：在真实的理解/流程类问题上，当 agent 使用
# synapse（explore/node）时，它是否仍会 Read？待验证前提：
# explore/node 返回带行号的源码，因此不应再需要 Read。
#
# 有 synapse（预热守护进程，可靠的嵌套挂载）vs 无（空 MCP，仅 Read/Grep），
# 各 N 次运行，在代码库的临时副本上进行。报告 explore/node vs Read/Grep，
# 并列出 WITH 组中被 Read 的文件，以区分真实的充分性缺口
#（已索引的源文件）和范围外内容（配置、文档、synapse 未索引的文件）。
#
# 用法：ab-sufficiency.sh <indexed-repo> "<question>" [runs-per-arm]
# 环境变量：AGENT_EVAL_OUT（默认：/tmp/ab-sufficiency）
set -uo pipefail
REPO="${1:?usage: ab-sufficiency.sh <indexed-repo> \"<question>\" [runs]}"
Q="${2:?question required}"
RUNS="${3:-2}"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ENGINE/dist/bin/synapse.js"
OUT="${AGENT_EVAL_OUT:-/tmp/ab-sufficiency}"
TGT="$OUT/target"
command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
[ -d "$REPO/.synapse" ] || { echo "no .synapse index at $REPO"; exit 1; }
cleanup(){ pkill -9 -f "serve --mcp --path $TGT" 2>/dev/null; }
trap cleanup EXIT
mkdir -p "$OUT"
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "built"

# 临时副本 + 全新索引（agent 在此工作；只读问题不会编辑，但仍需隔离）。
# 排除源代码库的索引/构建/版本控制目录。
rm -rf "$TGT"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .synapse "$REPO/" "$TGT/"
node "$BIN" init "$TGT" >/dev/null 2>&1 && echo "indexed copy ($(node "$BIN" status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).fileCount+" files")}catch{console.log("?")}})' 2>/dev/null || echo '?'))"

echo "###### repo=$REPO  runs/arm=$RUNS"
echo "###### Q=$Q"; echo
echo '{"mcpServers":{}}' > "$OUT/mcp-empty.json"
printf '{"mcpServers":{"synapse":{"command":"env","args":["SYNAPSE_WASM_RELAUNCHED=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$TGT" > "$OUT/mcp-cg.json"

prewarm(){
  pkill -9 -f "serve --mcp --path $TGT" 2>/dev/null
  SYNAPSE_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$TGT" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.synapse/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$TGT" >/dev/null 2>&1
}

analyze(){
  node -e '
    const fs=require("fs");
    const L=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
    let ex=0,nf=0,ns=0,oc=0,gr=0,exposed="?";const reads=[];
    for(const l of L){try{const o=JSON.parse(l);
      if(o.type==="system"&&o.subtype==="init")exposed=(o.tools||[]).filter(t=>/synapse/.test(t)).length;
      for(const b of (o.message?.content||[])){if(b.type!=="tool_use")continue;
        if(b.name==="mcp__synapse__synapse_explore")ex++;
        else if(b.name==="mcp__synapse__synapse_node"){if(b.input&&b.input.symbol)ns++;else nf++;}
        else if(/mcp__synapse__/.test(b.name))oc++;
        else if(b.name==="Read")reads.push((b.input?.file_path||"").split("/").pop());
        else if(b.name==="Grep")gr++;
      }}catch{}}
    console.log(`    explore=${ex} node[sym]=${ns} node[file]=${nf} other_cg=${oc} | Read=${reads.length}${reads.length?" ("+reads.join(", ")+")":""} Grep=${gr}  [cg exposed=${exposed}]`);
  ' "$1"
}

run(){ # label, cfg, prewarm(0/1)
  local label="$1" cfg="$2" pw="$3"
  for i in $(seq 1 "$RUNS"); do
    [ "$pw" = "1" ] && prewarm
    ( cd "$TGT" && claude -p "$Q" --output-format stream-json --verbose \
        --permission-mode bypassPermissions --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 \
        --strict-mcp-config --mcp-config "$cfg" </dev/null > "$OUT/$label-$i.jsonl" 2>"$OUT/$label-$i.err" )
    echo "[$label] run $i:"; analyze "$OUT/$label-$i.jsonl"
  done
  echo
}

echo "== WITH synapse (premise: explore/node used -> Read ~0) =="; run with "$OUT/mcp-cg.json" 1
echo "== WITHOUT (Read/Grep only — the contrast) =="; run without "$OUT/mcp-empty.json" 0
echo "###### DONE. In the WITH arm: are explore/node>0 and Read~0? Any Read of an INDEXED source file = sufficiency gap. Logs: $OUT"
