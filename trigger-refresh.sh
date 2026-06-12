#!/bin/bash
# Fires a real (non-throttled) Mail Brief refresh. Run by a launchd timer every
# 15 minutes while the Mac is on. GitHub throttles scheduled crons but honors
# manual workflow_dispatch immediately, so this keeps mail genuinely fresh.
# User-approved 2026-06-12. Remove with:
#   launchctl unload ~/Library/LaunchAgents/com.mailbrief.refresh.plist
#   rm ~/Library/LaunchAgents/com.mailbrief.refresh.plist
export PATH="/usr/local/bin:/usr/bin:/bin"
cd "$HOME/mail-brief" || exit 0
"$HOME/gh" workflow run refresh-mail.yml >> "$HOME/mail-brief/.refresh-trigger.log" 2>&1
echo "triggered $(date)" >> "$HOME/mail-brief/.refresh-trigger.log"
