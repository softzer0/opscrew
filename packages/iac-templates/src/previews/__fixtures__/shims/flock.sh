#!/usr/bin/env bash
# The fake flock of a preview server's tests (see ../server.ts).
echo "flock $*" >> "$WORK/state/flock.log"
fd="${*: -1}"
if [[ -n "${FLOCK_BUSY:-}" && "$fd" == "$FLOCK_BUSY" ]]; then exit 1; fi
if [[ "$fd" == 8 && -n "${FLOCK_MAKES:-}" ]]; then mkdir -p "$WORK/srv/apps/$FLOCK_MAKES"; fi
# Another removal took the folder FLOCK_TAKES away while this one waited (once).
if [[ "$fd" == 7 && -n "${FLOCK_TAKES:-}" && ! -f "$WORK/state/taken" ]]; then
  rm -rf "$WORK/srv/apps/$FLOCK_TAKES"
  : > "$WORK/state/taken"
fi
exit 0
