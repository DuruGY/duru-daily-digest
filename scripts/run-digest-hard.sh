#!/usr/bin/env bash
set -euo pipefail

# Hard pipeline for daily digest pre-processing:
# 1) select rotating sources
# 2) fetch RSS
# 3) compress with local Ollama (strict)

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS_DIR="$SKILL_DIR/scripts"
REF_DIR="$SKILL_DIR/references"

HOURS="${1:-24}"
TOP_N="${2:-15}"
TZ="${3:-Asia/Shanghai}"
MODEL="${4:-qwen3.5:2b}"
CONCURRENCY="${5:-6}"

RAW_JSON="$SKILL_DIR/out.json"
COMPACT_JSON="$SKILL_DIR/out.compact.json"
ACTIVE_SOURCES="$REF_DIR/sources.active.json"
META_JSON="$SKILL_DIR/out.meta.json"

node "$SCRIPTS_DIR/select-sources-rotation.mjs" \
  --sources "$REF_DIR/sources.json" \
  --out "$ACTIVE_SOURCES" \
  --tz "$TZ" >/tmp/digest_rotation_meta.json

node "$SCRIPTS_DIR/fetch-rss.mjs" \
  --hours "$HOURS" \
  --sources "$ACTIVE_SOURCES" \
  --exclude-seen-hours 0 \
  --no-history-write > "$RAW_JSON"

# compress up to TOP_N*2 for ranking headroom
LIMIT=$(( TOP_N * 2 ))
node "$SCRIPTS_DIR/compress-with-ollama.mjs" \
  --in "$RAW_JSON" \
  --out "$COMPACT_JSON" \
  --model "$MODEL" \
  --limit "$LIMIT" \
  --concurrency "$CONCURRENCY" \
  --strict >/tmp/digest_compress_meta.json

python3 - <<'PY' "$RAW_JSON" "$COMPACT_JSON" "$META_JSON" "$HOURS" "$TOP_N" "$TZ" "$MODEL" "$CONCURRENCY"
import json,sys,datetime
raw_p,compact_p,meta_p,hours,top_n,tz,model,concurrency=sys.argv[1:9]
raw=json.load(open(raw_p))
compact=json.load(open(compact_p))
meta={
  "generated_at": datetime.datetime.now().isoformat(),
  "hours": int(hours),
  "top_n": int(top_n),
  "tz": tz,
  "compress_model": model,
  "compress_concurrency": int(concurrency),
  "raw_count": len(raw),
  "compact_count": len(compact),
  "raw_path": raw_p,
  "compact_path": compact_p,
}
json.dump(meta, open(meta_p,'w'), ensure_ascii=False, indent=2)
print(json.dumps(meta, ensure_ascii=False, indent=2))
PY

echo "[digest-hard] ready: compact=$COMPACT_JSON meta=$META_JSON" >&2
