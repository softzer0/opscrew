#!/bin/bash
# The fake mysql of the agent's tests (see ../account.ts): the query for the tables to drop answers
# one; anything read from standard input becomes the fake database ($STUB/db), its state= line,
# after the drop it must start with. A dump whose state= line is the one in $STUB/refuse fails,
# with the database left as it was.
echo "mysql $*" >> "$STUB/mysql.log"
if [[ " $* " == *" -e "* ]]; then
  echo 'DROP TABLE IF EXISTS `notes`;'
  exit 0
fi
input=$(cat)
if [[ $input != "SET FOREIGN_KEY_CHECKS=0;"$'\n''DROP TABLE IF EXISTS `notes`;'* ]]; then
  echo "ERROR: the tables were not dropped first" >&2
  exit 1
fi
state=$(grep '^state=' <<< "$input")
if [ -f "$STUB/refuse" ] && [ "$state" = "$(cat "$STUB/refuse")" ]; then
  echo "ERROR 1064 (42000): You have an error in your SQL syntax" >&2
  exit 1
fi
echo "$state" > "$STUB/db"
