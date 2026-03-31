#!/bin/bash
# =============================================================================
# Echo Pipeline: subtitle-automation → echoEnglish
#
# 1. Run subtitle-automation (npm run dev) → syncs audio+LRC to SYNC_DIR
# 2. Detect which timestamp folders were just created
# 3. Run echoEnglish (--scan) on ONLY those new folders
#
# Usage:
#   echo_pipeline              # full pipeline
#   echo_pipeline --echo DIR   # skip subtitle, run echoEnglish on a specific folder
# =============================================================================

set -euo pipefail

SUBTITLE_DIR="/Volumes/SP/code/subtitle-automation"
ECHO_DIR="/Volumes/SP/code/python/echoEnglish"

# Read SYNC_DIR from subtitle-automation's .env
SYNC_DIR=""
if [[ -f "$SUBTITLE_DIR/.env" ]]; then
    SYNC_DIR=$(grep -E '^SYNC_DIR=' "$SUBTITLE_DIR/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

if [[ -z "$SYNC_DIR" ]]; then
    echo "❌ SYNC_DIR not found in $SUBTITLE_DIR/.env"
    exit 1
fi

log() {
    echo "[$(date '+%Y/%m/%d %H:%M:%S')] $*"
}

# Determine target voice from folder name
get_target_voice() {
    local name="$1"
    if echo "$name" | grep -qi "English"; then
        echo "en-US-JennyNeural"
    elif echo "$name" | grep -qi "Japanese"; then
        echo "ja-JP-NanamiNeural"
    else
        echo "en-US-JennyNeural"
    fi
}

# Run echoEnglish --scan on a single folder
run_echo_on_folder() {
    local folder="$1"
    local folder_name
    folder_name=$(basename "$folder")
    local target_voice
    target_voice=$(get_target_voice "$folder_name")

    log "📂 Processing: $folder_name"
    log "🎤 Target: $target_voice | Native: zh-CN-XiaoxiaoNeural"

    cd "$ECHO_DIR"
    python main.py --scan "$folder" \
        --target-voice "$target_voice" \
        --native-voice zh-CN-XiaoxiaoNeural \
        --mode audio
}

# ── Main ──
if [[ "${1:-}" == "--echo" ]]; then
    # Manual mode: run echoEnglish on a specific folder
    if [[ -z "${2:-}" ]]; then
        echo "Usage: echo_pipeline --echo <folder_path>"
        exit 1
    fi
    log "🔊 Running echoEnglish on: $2"
    run_echo_on_folder "$2"
    log "🏁 Done!"
    exit 0
fi

log "🚀 Echo Pipeline started"
log "📂 SYNC_DIR: $SYNC_DIR"

# Snapshot: list folders BEFORE running subtitle-automation
before_folders=$(find "$SYNC_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)

# Step 1: subtitle-automation
log ""
log "🎬 Step 1: Running subtitle-automation..."
cd "$SUBTITLE_DIR"
npm run dev

log "✅ subtitle-automation completed."

# Step 2: find NEW folders (created during step 1)
after_folders=$(find "$SYNC_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)

# Diff to get only newly created folders
new_folders=()
while IFS= read -r folder; do
    [[ -n "$folder" ]] && new_folders+=("$folder")
done < <(comm -13 <(echo "$before_folders") <(echo "$after_folders"))

if [[ ${#new_folders[@]} -eq 0 ]]; then
    log ""
    log "ℹ️  No new sync folders created. Nothing new to process."
    log "🏁 Pipeline finished!"
    exit 0
fi

log ""
log "🔊 Step 2: Running echoEnglish on ${#new_folders[@]} new folder(s)..."

for folder in "${new_folders[@]}"; do
    log ""
    log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    run_echo_on_folder "$folder"
    log "✅ Done: $(basename "$folder")"
done

log ""
log "🏁 Pipeline finished!"
