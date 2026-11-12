#!/bin/bash
# The fake curl of the agent's tests (see ../account.ts): the hostname as LiteSpeed would serve the
# account's running release, $APP_DIR/current/$SERVED. HTTPS verifies only once $STUB/certificate
# exists. A one-time purge file is recorded in $STUB/purges as there or missing while it is asked
# for. Otherwise the answer's status is the served folder's health-status file (200 without one),
# with the X-OpsCrew-Release header of its .htaccess. Headers are printed only for -D -.
url=${*: -1}
echo "curl $url" >> "$STUB/curl.log"
if [[ $url == https://* && ! -f $STUB/certificate ]]; then
  echo "curl: (60) SSL certificate problem: unable to get local issuer certificate" >&2
  exit 60
fi
rest=${url#*://}
path=/${rest#*/}
served=$APP_DIR/current/$SERVED
status=200
release=""
if [[ $path == /opscrew-purge-*.php ]]; then
  if [ -f "$served$path" ]; then echo "there $path" >> "$STUB/purges"; else echo "missing $path" >> "$STUB/purges"; fi
else
  if [ -f "$served/health-status" ]; then status=$(cat "$served/health-status"); fi
  if [ -f "$served/.htaccess" ]; then
    release=$(sed -n 's/^Header always set X-OpsCrew-Release "\(.*\)"$/\1/p' "$served/.htaccess")
  fi
fi
if [[ " $* " == *" -D - "* ]]; then
  printf 'HTTP/1.1 %s Answer\r\nServer: LiteSpeed\r\nX-OpsCrew-Release: %s\r\n\r\n' "$status" "$release"
fi
