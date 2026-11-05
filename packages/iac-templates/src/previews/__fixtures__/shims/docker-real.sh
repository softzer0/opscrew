#!/usr/bin/env bash
# The real docker ($REAL_DOCKER) for the Docker-gated test, except the registry login: its preview
# runs a public image, so the login only leaves a config file where docker would.
case "$1" in
  login)
    cat > /dev/null
    mkdir -p "$DOCKER_CONFIG"
    echo '{"auths":{}}' > "$DOCKER_CONFIG/config.json"
    echo "Login Succeeded"
    ;;
  logout) rm -f "${DOCKER_CONFIG:-/none}/config.json" ;;
  *) exec "$REAL_DOCKER" "$@" ;;
esac
