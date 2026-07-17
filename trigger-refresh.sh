#!/bin/bash
# Fires a real (non-throttled) Mail Brief refresh. Run by a launchd timer every
# 15 minutes while the Mac is on. GitHub throttles scheduled crons but honors
# manual workflow_dispatch immediately, so this keeps mail genuinely fresh.
# User-approved 2026-06-12. Remove with:
#   launchctl unload ~/Library/LaunchAgents/com.mailbrief.refresh.plist
#   rm ~/Library/LaunchAgents/com.mailbrief.refresh.plist
export PATH="/usr/local/bin:/usr/bin:/bin"
cd "$HOME/mail-brief" || exit 0
LOG="$HOME/mail-brief/.refresh-trigger.log"
# Keep the log from growing without bound: trim to the last 500 lines.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 500 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
"$HOME/gh" workflow run refresh-mail.yml >> "$LOG" 2>&1
echo "triggered $(date)" >> "$LOG"
