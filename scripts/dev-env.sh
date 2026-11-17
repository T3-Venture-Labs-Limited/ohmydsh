# Source this in sandboxed or CI-like environments to keep every pnpm/npm write inside the repo's .tmp/.
# (pnpm 12 needs a writable XDG_RUNTIME_DIR for its store locks.)
OMD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
W="$OMD_ROOT/.tmp"
mkdir -p "$W/tmp" "$W/run" "$W/state" "$W/xdg/cache" "$W/pnpm-store" "$W/npm-cache"
chmod 700 "$W/run"
export TMPDIR="$W/tmp" XDG_RUNTIME_DIR="$W/run" XDG_CACHE_HOME="$W/xdg/cache" npm_config_cache="$W/npm-cache"
export npm_config_store_dir="$W/pnpm-store" npm_config_state_dir="$W/state"
