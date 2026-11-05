#!/usr/bin/env bash
# The fake sleep of a preview server's tests (see ../server.ts): returns at once.
echo "sleep $*" >> "$WORK/state/docker.log"
