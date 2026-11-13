#!/bin/bash
# The fake CloudLinux selector of the agent's tests (see ../account.ts), as the real one behaved on
# the cPanel test account (027 research R10, R14), for an app served at its hostname's root. Each
# call is logged in $STUB/selector.log; install-modules also logs the package.json it finds in the
# app root. A command named in $STUB/selector-fails answers an error.
# It resolves --app-root (from the home folder) once, as the real one does: its registry,
# $STUB/selector-apps (the real one's is ~/.cl.selector/node-selector.json), keys each app by the
# resolved folder ("<interpreter> <folder> <version> <startup file>" lines), and every command but
# create answers "No such application" for a folder it doesn't hold.
# create makes ~/nodevenv/<resolved root>/<version>/lib/node_modules (virtualenv for Python), links
# the app root's node_modules to it (Node.js), puts its placeholder app (the startup file, which
# answers "It works!") into the app root, writes its Passenger block, naming the resolved root, into
# the .htaccess the hostname serves ($APP_DIR/current/$SERVED, its document root), and adds the
# app's section to ~/.cl.selector/htaccess_cache; set keeps --env-vars' JSON in $STUB/env-vars and
# writes the block again, as an update of the app may; destroy empties the environment's folder and
# forgets the app, leaving the rest, as the real one does (R10).
echo "cloudlinux-selector $*" >> "$STUB/selector.log"
command=$1
shift
interpreter="" root="" version="" env_vars="" startup=""
while [ $# -gt 0 ]; do
  case $1 in
    --interpreter) interpreter=$2; shift ;;
    --app-root) root=$2; shift ;;
    --version) version=$2; shift ;;
    --env-vars) env_vars=$2; shift ;;
    --startup-file) startup=$2; shift ;;
  esac
  shift
done
if [ -f "$STUB/selector-fails" ] && grep -qx "$command" "$STUB/selector-fails"; then
  # A refused set repeats the values it was given, as an answer might.
  echo "{\"result\": \"Something went wrong in the fake selector${env_vars:+ with $env_vars}\"}"
  exit 1
fi
venv=nodevenv
[ "$interpreter" = nodejs ] || venv=virtualenv
if [ "$command" = create ]; then mkdir -p "$HOME/$root"; fi
# The app root as the selector keeps it: the folder --app-root resolves to, from the home folder.
home=$(cd "$HOME" && pwd -P)
resolved=$(cd "$HOME/$root" 2> /dev/null && pwd -P) || resolved=""
resolved=${resolved#"$home/"}
app=$HOME/$resolved

# The registered app's version and startup file, or a failure when the registry doesn't hold it.
registered() {
  local i r v s
  [ -f "$STUB/selector-apps" ] || return 1
  while read -r i r v s; do
    if [ "$i $r" = "$interpreter $resolved" ]; then
      version=$v startup=$s
      return 0
    fi
  done < "$STUB/selector-apps"
  return 1
}

if [ "$command" != create ] && { [ -z "$resolved" ] || ! registered; }; then
  path=$HOME/$root
  [ -z "$resolved" ] || path=$app
  echo "{\"result\": \"No such application or it's broken. Unable to find app-root folder by this path $path\"}"
  exit 1
fi
# install-modules fails for an app root whose package.json holds $STUB/install-fails-for's text.
if [ "$command" = install-modules ] && [ -f "$STUB/install-fails-for" ] &&
  grep -qF "$(cat "$STUB/install-fails-for")" "$app/package.json" 2> /dev/null; then
  echo "package.json: $(cat "$app/package.json")" >> "$STUB/selector.log"
  echo '{"result": "npm install failed"}'
  exit 1
fi
served=$APP_DIR/current/$SERVED/.htaccess
begin='# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN'
end='# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END'

# Writes the app's Passenger block at the end of the served .htaccess, in place of one there.
passenger() {
  local lines
  if [ "$interpreter" = nodejs ]; then
    lines=("PassengerNodejs \"$HOME/$venv/$resolved/$version/bin/node\"" 'PassengerAppType node' "PassengerStartupFile $startup")
  else
    lines=("PassengerPython \"$HOME/$venv/$resolved/$version/bin/python\"")
  fi
  if [ -f "$served" ]; then sed -i "/^$begin\$/,/^$end\$/d" "$served"; fi
  printf '%s\n' "$begin" "PassengerAppRoot \"$app\"" "${lines[@]}" 'PassengerBaseURI "/"' "$end" >> "$served"
}

case $command in
  create)
    echo "$interpreter $resolved $version $startup" >> "$STUB/selector-apps"
    mkdir -p "$HOME/$venv/$resolved/$version/lib/node_modules" "$(dirname "$app/$startup")"
    if [ "$interpreter" = nodejs ]; then ln -s "$HOME/$venv/$resolved/$version/lib/node_modules" "$app/node_modules"; fi
    [ -e "$app/$startup" ] || printf '%s\n' "// CloudLinux's placeholder: It works!" > "$app/$startup"
    passenger
    mkdir -p "$HOME/.cl.selector"
    printf '[%s/%s]\napp_root = %s\n\n' "$HOME" "$resolved" "$resolved" >> "$HOME/.cl.selector/htaccess_cache"
    ;;
  set)
    printf '%s' "$env_vars" > "$STUB/env-vars"
    passenger
    ;;
  install-modules)
    echo "package.json: $(cat "$app/package.json" 2> /dev/null)" >> "$STUB/selector.log"
    ;;
  destroy)
    rm -rf "${HOME:?}/$venv/$resolved/"*
    while read -r i r rest; do
      [ "$i $r" = "$interpreter $resolved" ] || echo "$i $r $rest"
    done < "$STUB/selector-apps" > "$STUB/selector-apps.next"
    mv "$STUB/selector-apps.next" "$STUB/selector-apps"
    ;;
esac
echo '{"result": "success", "timestamp": 1794000000.0}'
