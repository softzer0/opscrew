#!/bin/bash
# The fake sleep of the agent's tests (see ../account.ts): returns at once.
echo "sleep $*" >> "$STUB/sleep.log"
