#!/usr/bin/env bash
# Installs a cron job to run the lottery agent every Wednesday and Saturday at 17:00.
# Run once from the lottery_agent/ directory: bash setup_mac_cron.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="$(command -v python3)"
BOT="$SCRIPT_DIR/lottery_bot.py"
LOG="$SCRIPT_DIR/lottery_agent.log"

if [[ -z "$PYTHON" ]]; then
  echo "python3 not found. Install it from https://www.python.org/downloads/"
  exit 1
fi

# Ireland Standard Time (IST) is Europe/Dublin.
# If your Mac is NOT already set to Europe/Dublin, the job below will fire at
# 17:00 in YOUR local timezone.  To always fire at 17:00 IST regardless of
# your system clock, prefix the command with:
#   TZ=Europe/Dublin
#
# Cron schedule breakdown:
#   minute hour  day-of-month  month  day-of-week
#     0     17        *          *       3,6
#
# day-of-week: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat

CRON_LINE="0 17 * * 3,6 TZ=Europe/Dublin $PYTHON $BOT >> $LOG 2>&1"

# Add the line only if it isn't already present
( crontab -l 2>/dev/null | grep -vF "lottery_bot.py" ; echo "$CRON_LINE" ) | crontab -

echo "Cron job installed:"
crontab -l | grep lottery_bot
echo ""
echo "The agent will run every Wednesday and Saturday at 17:00 Irish time."
echo "Logs: $LOG"
echo "Screenshots: $SCRIPT_DIR/screenshots/"
