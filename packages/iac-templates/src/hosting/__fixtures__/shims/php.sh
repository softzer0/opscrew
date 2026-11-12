#!/bin/bash
# The fake PHP CLI of the agent's tests (see ../account.ts), logged in $STUB/php.log with the
# folder it ran in. -v and -m answer as the version in its path would (7.0 for the account's own).
# Laravel's artisan: optimize and config:cache write the cached config anew (as Laravel clears it
# first); migrate fails in a release holding fail-migrate, and otherwise makes the fake database
# ($STUB/db) the release's (the release-marker file).
echo "php $* in ${PWD##*/}" >> "$STUB/php.log"
version=7.0.33
case $0 in *php85*) version=8.5.12 ;; esac
case " $* " in
  " -v ")
    echo "PHP $version (cli) (built: Oct 30 2026 10:00:00) ( NTS )"
    echo "Copyright (c) The PHP Group"
    ;;
  " -m ")
    printf '[PHP Modules]\nCore\nctype\npdo_mysql\n\n[Zend Modules]\nZend OPcache\n\n'
    ;;
  *" artisan optimize "* | *" artisan config:cache "*)
    mkdir -p bootstrap/cache
    rm -f bootstrap/cache/config.php
    echo "<?php return ['app' => ['key' => 'from .env']];" > bootstrap/cache/config.php
    ;;
  *" artisan migrate "*)
    if [ -f fail-migrate ]; then
      echo "SQLSTATE[42S01]: Base table or view already exists" >&2
      exit 1
    fi
    echo "state=$(cat release-marker)" > "$STUB/db"
    ;;
esac
