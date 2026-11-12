#!/bin/bash
# The fake mysqldump of the agent's tests (see ../account.ts): prints the fake database, $STUB/db.
echo "mysqldump $*" >> "$STUB/mysql.log"
echo "-- MariaDB dump 10.19"
cat "$STUB/db"
