#!/usr/bin/env bash
# The fake kamal-proxy of a preview server's tests (see ../server.ts).
S="$WORK/state"
echo "kamal-proxy $*" >> "$S/kamal.log"
case "$1" in
  deploy)
    target=""
    host=""
    prev=""
    for arg in "$@"; do
      if [[ "$prev" == --target ]]; then target="$arg"; fi
      if [[ "$prev" == --host ]]; then host="$arg"; fi
      prev="$arg"
    done
    image=""
    while read -r _ _ _ i _ name; do [[ "$name" == "${target%:*}" ]] && image="$i"; done < "$S/containers"
    if [[ -z "$image" || " ${UNHEALTHY:-} " == *" $image "* ]]; then
      echo "Error: target failed to become healthy within configured timeout (60s)" >&2
      exit 1
    fi
    echo "$target $host" > "$S/routes/$2"
    ;;
  remove)
    if [[ ! -f "$S/routes/$2" ]]; then
      echo "Error: service not found" >&2
      exit 1
    fi
    rm -f "$S/routes/$2"
    ;;
  pause | resume)
    if [[ ! -f "$S/routes/$2" ]]; then
      echo "Error: service not found" >&2
      exit 1
    fi
    ;;
esac
