#!/usr/bin/env bash
# The fake docker of a preview server's tests (see ../server.ts). It runs no other program where
# bash's builtins do, as each process costs a lot under Git for Windows.
S="$WORK/state"
echo "docker $*" >> "$S/docker.log"
project="${PWD##*/}"

# Each container: <id> <project> <service> <image> <status> <name>.
mapfile -t CONTAINERS < "$S/containers"
save() {
  local line
  : > "$S/containers"
  for line in "${CONTAINERS[@]}"; do echo "$line" >> "$S/containers"; done
}
# IMAGE: the image of the service $1, the app's from APP_IMAGE or .env.
image_of() {
  local line
  IMAGE="image-of-$1"
  case "$1" in
    app | worker | cron)
      IMAGE="${APP_IMAGE:-}"
      if [[ -z "$IMAGE" ]]; then
        while read -r line; do [[ "$line" == APP_IMAGE=* ]] && IMAGE="${line#APP_IMAGE=}"; done < .env
      fi
      ;;
  esac
}
start() {
  local n=1 line
  [[ -f "$S/next" ]] && read -r n < "$S/next"
  echo $((n + 1)) > "$S/next"
  image_of "$1"
  CONTAINERS+=("c$n $project $1 $IMAGE running $project-$1-$n")
  while read -r line; do [[ "$line" == "${project}_internal $project" ]] && return; done < "$S/networks"
  echo "${project}_internal $project" >> "$S/networks"
}
drop() {
  local i
  for i in "${!CONTAINERS[@]}"; do
    [[ "${CONTAINERS[$i]}" == "$1 "* ]] && unset 'CONTAINERS[i]'
  done
}
# IDS: field $1 (1 the id, 6 the name) of each container whose project, service and status are
# $2, $3 and $4 (empty matches any).
each() {
  local line id p s i st n
  IDS=()
  for line in "${CONTAINERS[@]}"; do
    read -r id p s i st n <<< "$line"
    [[ -z "$2" || "$p" == "$2" ]] && [[ -z "$3" || "$s" == "$3" ]] && [[ -z "$4" || "$st" == "$4" ]] || continue
    if [[ "$1" == 1 ]]; then IDS+=("$id"); else IDS+=("$n"); fi
  done
}
# LABEL: the project of the argument label=com.docker.compose.project=<project>.
label_project() {
  local arg
  LABEL=""
  for arg in "$@"; do [[ "$arg" == label=* ]] && LABEL="${arg#label=com.docker.compose.project=}"; done
}
# Prints the first word of each line of the file $1 whose second word is $2.
owned() {
  local name owner
  while read -r name owner; do [[ "$owner" == "$2" ]] && echo "$name"; done < "$1"
}
# Drops the lines whose first word is one of the other arguments from the file $1.
drop_from() {
  local file="$1" line name keep lines
  shift
  mapfile -t lines < "$file"
  : > "$file"
  for line in "${lines[@]}"; do
    keep=1
    for name in "$@"; do [[ "${line%% *}" == "$name" ]] && keep=""; done
    [[ -n "$keep" ]] && echo "$line" >> "$file"
  done
}

if [[ "$1" == compose ]]; then
  shift
  while [[ "$1" == -p || "$1" == -f ]]; do
    if [[ "$1" == -p ]]; then project="$2"; fi
    shift 2
  done
  if [[ "$project" != opscrew-edge && ! -f compose.yaml ]]; then
    echo "no configuration file provided: not found" >&2
    exit 1
  fi
  sub="$1"
  shift
  case "$sub" in
    pull)
      if [[ -f "${DOCKER_CONFIG:-/none}/config.json" ]]; then echo "docker pulled-logged-in $project" >> "$S/docker.log"; fi
      if [[ -n "${PULL_FAIL:-}" ]]; then
        echo "Error response from daemon: denied"
        exit 1
      fi
      echo "Pulling $project done"
      ;;
    up)
      if [[ "$project" == opscrew-edge ]]; then
        echo "Container opscrew-edge-caddy-1 Healthy"
        [[ -z "${EDGE_UP_FAIL:-}" ]]
        exit
      fi
      if [[ -n "${UP_FAIL:-}" ]]; then
        echo "Error: dependency failed to start" >&2
        exit 1
      fi
      want=""
      services=()
      prev=""
      for arg in "$@"; do
        if [[ "$prev" == --scale ]]; then
          want="${arg#app=}"
        elif [[ "$arg" != -* ]]; then
          services+=("$arg")
        fi
        prev="$arg"
      done
      for svc in "${services[@]}"; do
        if [[ "$svc" == app && -n "$want" ]]; then
          each 1 "$project" app ""
          for ((k = ${#IDS[@]}; k < want; k++)); do start app; done
        elif [[ "$svc" == app ]]; then
          each 1 "$project" app ""
          for id in "${IDS[@]}"; do drop "$id"; done
          start app
        else
          image_of "$svc"
          for line in "${CONTAINERS[@]}"; do
            read -r id p s i _ <<< "$line"
            [[ "$p" == "$project" && "$s" == "$svc" && "$i" != "$IMAGE" ]] && drop "$id"
          done
          each 1 "$project" "$svc" ""
          [[ ${#IDS[@]} -gt 0 ]] || start "$svc"
        fi
      done
      save
      ;;
    ps)
      if [[ " $* " == *" -aq "* ]]; then each 1 "$project" "${*: -1}" ""; else each 1 "$project" "${*: -1}" running; fi
      [[ ${#IDS[@]} -eq 0 ]] || printf '%s\n' "${IDS[@]}"
      ;;
    run)
      svc="${*: -1}"
      echo "docker ran $svc in $project with ${APP_IMAGE:-}" >> "$S/docker.log"
      if [[ "$svc" == release && -n "${RELEASE_FAIL:-}" ]]; then
        echo "migration failed: duplicate key value (id)=(7)"
        exit 3
      fi
      if [[ "$svc" == seed && -n "${SEED_FAIL:-}" ]]; then
        echo "seed failed: relation users does not exist"
        exit 1
      fi
      echo "$svc output of $project"
      ;;
    exec)
      if [[ "$2" == kamal-proxy ]]; then
        shift 3
        exec kamal-proxy "$@"
      fi
      ;;
    stop)
      for i in "${!CONTAINERS[@]}"; do
        read -r id p s img st n <<< "${CONTAINERS[$i]}"
        for svc in "$@"; do
          [[ "$p" == "$project" && "$s" == "$svc" ]] && CONTAINERS[i]="$id $p $s $img exited $n"
        done
      done
      save
      ;;
  esac
  exit 0
fi

case "$1" in
  login)
    read -r token || true
    if [[ -n "${LOGIN_FAIL:-}" ]]; then
      echo "Error response from daemon: denied" >&2
      exit 1
    fi
    mkdir -p "$DOCKER_CONFIG"
    echo "{\"auths\":{\"ghcr.io\":{\"user\":\"$4\",\"token-length\":${#token}}}}" > "$DOCKER_CONFIG/config.json"
    echo "Login Succeeded"
    ;;
  logout) rm -f "${DOCKER_CONFIG:-/none}/config.json" ;;
  inspect)
    case "$3" in
      "{{.Name}}") for line in "${CONTAINERS[@]}"; do [[ "$line" == "${*: -1} "* ]] && echo "/${line##* }"; done ;;
      "{{.RestartCount}}") echo 0 ;;
      *) echo running:0 ;;
    esac
    ;;
  rm)
    if [[ -n "${RM_FAIL:-}" ]]; then
      echo "Error response from daemon: cannot remove container: device or resource busy" >&2
      exit 1
    fi
    shift
    for id in "$@"; do [[ "$id" == -f ]] || drop "$id"; done
    save
    ;;
  ps)
    label_project "$@"
    if [[ "$2" == -aq ]]; then each 1 "$LABEL" "" ""; else each 6 "$LABEL" "" ""; fi
    [[ ${#IDS[@]} -eq 0 ]] || printf '%s\n' "${IDS[@]}"
    ;;
  logs)
    if [[ "$2" == --tail ]]; then
      echo "last line of $4"
      echo "error line of $4" >&2
    else
      echo "copy-line of ${*: -1}"
    fi
    ;;
  network)
    case "$2" in
      inspect) [[ -f "$S/network-$3" ]] || exit 1 ;;
      create) : > "$S/network-$3" ;;
      ls) label_project "$@"; owned "$S/networks" "$LABEL" ;;
      rm) shift 2; drop_from "$S/networks" "$@" ;;
    esac
    ;;
  volume)
    case "$2" in
      ls) label_project "$@"; owned "$S/volumes" "$LABEL" ;;
      rm) shift 2; drop_from "$S/volumes" "$@" ;;
    esac
    ;;
  run)
    # The data's removal as root: rm -rf /d/<name> with the data folder mounted on /d.
    mount=""
    prev=""
    for arg in "$@"; do
      if [[ "$prev" == -v ]]; then mount="$arg"; fi
      prev="$arg"
    done
    last="${*: -1}"
    rm -rf "${mount%:/d}/${last#/d/}"
    ;;
esac
exit 0
