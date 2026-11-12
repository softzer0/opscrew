#!/bin/bash
# The fake ssh of the agent's tests (see ../account.ts): GitHub refusing a key it doesn't know yet,
# except on port 22 when $STUB/no-22 exists, where the connection times out.
echo "ssh $*" >> "$STUB/ssh.log"
if [[ " $* " == *" -p 22 "* && -f $STUB/no-22 ]]; then
  echo "ssh: connect to host github.com port 22: Connection timed out" >&2
  exit 255
fi
echo "git@github.com: Permission denied (publickey)." >&2
exit 255
