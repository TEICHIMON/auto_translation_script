#!/bin/bash
# =============================================================================
# Echo Pipeline: subtitle-automation → echoEnglish
#
# 1. Run subtitle-automation (npm run dev) → syncs audio+LRC to SYNC_DIR
# 2. Detect which timestamp folders were just created
# 3. Run echoEnglish (--scan) on ONLY those new folders
#
# All shell-side output is also tee'd to a master log under
#   $ECHO_DIR/logs/<timestamp>_pipeline_shell.log
# (Python writes its own central log to $ECHO_DIR/logs/<timestamp>_pipeline.log
# with structured timestamps; the two are complementary.)
#
# Individual folder failures no longer abort the whole pipeline — each
# folder's exit code is captured and the loop continues.
#
# Usage:
#   echo_pipeline              # full pipeline
#   echo_pipeline --echo DIR   # skip subtitle, run echoEnglish on a specific folder
# =============================================================================
set -uo pipefail
# NOTE: we intentionally drop -e so a single Python failure inside
#       run_echo_on_folder doesn't kill the whole pipeline. Errors are
#       handled explicitly with `if ... ; then ... else ... fi`.

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

# --- Master shell log: tee everything from this point on ---
mkdir -p "$ECHO_DIR/logs"
PIPELINE_LOG="$ECHO_DIR/logs/$(date +%Y%m%d_%H%M%S)_pipeline_shell.log"
exec > >(tee -a "$PIPELINE_LOG") 2>&1

log() {
    echo "[$(date '+%Y/%m/%d %H:%M:%S')] $*"
}

log "📝 Shell pipeline log: $PIPELINE_LOG"

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

# Run echoEnglish --scan on a single folder.
# Returns the exit code from python so callers can decide what to do.
run_echo_on_folder() {
    local folder="$1"
    local folder_name
    folder_name=$(basename "$folder")
    local target_voice
    target_voice=$(get_target_voice "$folder_name")
    log "📂 Processing: $folder_name"
    log "🎤 Target: $target_voice | Native: zh-CN-XiaoxiaoNeural"
    cd "$ECHO_DIR" || return 1
    /opt/homebrew/anaconda3/envs/echo_env/bin/python main.py --scan "$folder" \
        --target-voice "$target_voice" \
        --native-voice zh-CN-XiaoxiaoNeural \
        --mode audio
}

# ── Main ──
if [[ "${1:-}" == "--echo" ]]; then
    if [[ -z "${2:-}" ]]; then
        echo "Usage: echo_pipeline --echo <folder_path>"
        exit 1
    fi
    log "🔊 Running echoEnglish on: $2"
    if run_echo_on_folder "$2"; then
        log "🏁 Done!"
        exit 0
    else
        rc=$?
        log "❌ Failed: $2 (exit code: $rc)"
        exit $rc
    fi
fi

log "🚀 Echo Pipeline started"
log "📂 SYNC_DIR: $SYNC_DIR"

# Snapshot: list folders BEFORE running subtitle-automation
before_folders=$(find "$SYNC_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)

log ""
log "🎬 Step 1: Running subtitle-automation..."
cd "$SUBTITLE_DIR" || { log "❌ Cannot cd to $SUBTITLE_DIR"; exit 1; }
if ! npm run dev; then
    log "❌ subtitle-automation failed"
    exit 1
fi
log "✅ subtitle-automation completed."

# Step 2: find NEW folders (created during step 1)
after_folders=$(find "$SYNC_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)

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
log "   Folders to process:"
for folder in "${new_folders[@]}"; do
    log "     - $(basename "$folder")"
done

# Track success/failure for the final summary
succeeded=()
failed=()

for folder in "${new_folders[@]}"; do
    log ""
    log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if run_echo_on_folder "$folder"; then
        log "✅ Done: $(basename "$folder")"
        succeeded+=("$(basename "$folder")")
    else
        rc=$?
        log "❌ Failed: $(basename "$folder") (exit code: $rc, continuing with next)"
        failed+=("$(basename "$folder")")
    fi
done

log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "🏁 Pipeline finished!"
log "  ✓ Succeeded: ${#succeeded[@]} / ${#new_folders[@]}"
if [[ ${#failed[@]} -gt 0 ]]; then
    log "  ✗ Failed:    ${#failed[@]}"
    for name in "${failed[@]}"; do
        log "    - $name"
    done
    exit 1
fi