#!/bin/sh
# ohmydsh installer.
#
# NOTE: this works once @t3labs/ohmydsh is published to npm (the first v* release). Until then, from a checkout use:
#   pnpm install && node packages/cli/bin/omd.js setup --dev
#
# What it does: checks OS and Node >= 24, installs the omd command with npm, runs `omd setup`.
# It never uses sudo and never touches your existing DSH profiles.
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'ohmydsh: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "unsupported OS $(uname -s). On Windows use WSL." ;;
esac
case "$(uname -m)" in
  x86_64|amd64|arm64|aarch64) ;;
  *) die "unsupported CPU $(uname -m)." ;;
esac

command -v npm >/dev/null 2>&1 || die "npm not found. Install Node.js 24 first (see below)."
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js 24 first (see below)."

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 24 ]; then
  say "Node $(node -v) is too old; ohmydsh needs Node 24 or newer."
  say "Install it without sudo, for example:"
  say "  mise:  curl https://mise.run | sh && mise use -g node@24"
  say "  nvm:   nvm install 24 && nvm use 24"
  exit 1
fi

say "Installing the omd command (npm i -g @t3labs/ohmydsh)..."
npm install -g @t3labs/ohmydsh@latest || die "npm install failed. If it is a permissions error, set a user prefix: npm config set prefix ~/.local"

command -v omd >/dev/null 2>&1 || die "omd was installed but is not on your PATH. Add \"$(npm prefix -g)/bin\" to PATH and run: omd setup"

say "Running omd setup..."
omd setup

say ""
say "Done. Start it with: omd"
