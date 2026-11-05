# Runs opscrew-preview ($RECIPE_SCRIPT, by its absolute path as the forced command and cron do)
# with the shims first on the PATH and the arguments given; REAL_DOCKER is the docker the PATH had
# before. With GONE_CALLER the caller has gone away: the script's stdout is a closed pipe.
REAL_DOCKER="$(command -v docker || true)"
export REAL_DOCKER
PATH="$(cd "$WORK/bin" && pwd):$PATH"
export PATH
script="$(cd "${RECIPE_SCRIPT%/*}" && pwd)/${RECIPE_SCRIPT##*/}"
if [ -n "${GONE_CALLER:-}" ]; then
  sh "$script" "$@" | true
else
  exec sh "$script" "$@"
fi
