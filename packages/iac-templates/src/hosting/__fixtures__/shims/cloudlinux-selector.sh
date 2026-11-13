#!/bin/bash
# The fake CloudLinux selector of the agent's tests (see ../account.ts), for an app whose document
# root is its app root's public/. Each call is logged in $STUB/selector.log; install-modules also
# logs the package.json it finds in the app root. A command named in $STUB/selector-fails answers
# an error. create makes ~/nodevenv/<app root>/<version>/lib/node_modules (virtualenv for Python),
# links the app root's node_modules to it (Node.js), makes the app root's public/ and writes the
# Passenger block into its .htaccess, and adds the app's section to ~/.cl.selector/htaccess_cache;
# set keeps --env-vars' JSON in $STUB/env-vars; destroy empties the environment's folder and
# leaves the rest, as the real one does (027 research R10).
echo "cloudlinux-selector $*" >> "$STUB/selector.log"
command=$1
shift
interpreter="" root="" version="" env_vars=""
while [ $# -gt 0 ]; do
  case $1 in
    --interpreter) interpreter=$2; shift ;;
    --app-root) root=$2; shift ;;
    --version) version=$2; shift ;;
    --env-vars) env_vars=$2; shift ;;
  esac
  shift
done
if [ -f "$STUB/selector-fails" ] && grep -qx "$command" "$STUB/selector-fails"; then
  # A refused set repeats the values it was given, as an answer might.
  echo "{\"result\": \"Something went wrong in the fake selector${env_vars:+ with $env_vars}\"}"
  exit 1
fi
# install-modules fails for an app root whose package.json holds $STUB/install-fails-for's text.
if [ "$command" = install-modules ] && [ -f "$STUB/install-fails-for" ] &&
  grep -qF "$(cat "$STUB/install-fails-for")" "$HOME/$root/package.json" 2> /dev/null; then
  echo "package.json: $(cat "$HOME/$root/package.json")" >> "$STUB/selector.log"
  echo '{"result": "npm install failed"}'
  exit 1
fi
venv=nodevenv
[ "$interpreter" = nodejs ] || venv=virtualenv
case $command in
  create)
    mkdir -p "$HOME/$venv/$root/$version/lib/node_modules" "$HOME/$root/public"
    if [ "$interpreter" = nodejs ]; then ln -s "$HOME/$venv/$root/$version/lib/node_modules" "$HOME/$root/node_modules"; fi
    printf '%s\n' '# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN' "PassengerAppRoot \"$HOME/$root\"" \
      '# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END' >> "$HOME/$root/public/.htaccess"
    mkdir -p "$HOME/.cl.selector"
    printf '[%s/%s]\napp_root = %s\n\n' "$HOME" "$root" "$root" >> "$HOME/.cl.selector/htaccess_cache"
    ;;
  set)
    printf '%s' "$env_vars" > "$STUB/env-vars"
    ;;
  install-modules)
    echo "package.json: $(cat "$HOME/$root/package.json" 2> /dev/null)" >> "$STUB/selector.log"
    ;;
  destroy)
    rm -rf "${HOME:?}/$venv/$root/"*
    ;;
esac
echo '{"result": "success", "timestamp": 1794000000.0}'
