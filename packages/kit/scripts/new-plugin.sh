#!/usr/bin/env bash
# Create a new DSH plugin repo from dsh-kit/template.
#   scripts/new-plugin.sh <name> [--title "Title"] [--dir <parent>] [--scope @scope] [--author "Name"] [--no-install] [--no-git]
# <name> is the repo/directory name (lowercase letters, digits, hyphens), e.g. `demo` or `dsh-comments`.
# Package name = [<scope>/]<name>; plugin id = <name>. The kit (ui/) and token linter are copied in as source.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="" title="" parent="$(dirname "$here")" scope="" author="${GIT_AUTHOR_NAME:-$(git config user.name 2>/dev/null || echo "Author")}" install=1 git_init=1

usage() { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --title) title="$2"; shift 2 ;;
    --dir) parent="$2"; shift 2 ;;
    --scope) scope="$2"; shift 2 ;;
    --author) author="$2"; shift 2 ;;
    --no-install) install=0; shift ;;
    --no-git) git_init=0; shift ;;
    -*) echo "unknown option: $1" >&2; usage 1 ;;
    *) [[ -z "$name" ]] && name="$1" || { echo "unexpected argument: $1" >&2; usage 1; }; shift ;;
  esac
done
[[ -n "$name" ]] || usage 1
[[ "$name" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "name must match ^[a-z][a-z0-9-]*\$ (got: $name)" >&2; exit 1; }
[[ -z "$scope" || "$scope" =~ ^@[a-z0-9][a-z0-9-]*$ ]] || { echo "scope must look like @scope" >&2; exit 1; }

pkg="${scope:+$scope/}$name"
if [[ -z "$title" ]]; then
  # "dsh-comments" -> "Comments"; "demo" -> "Demo"
  base="${name#dsh-}"; title="$(echo "${base//-/ }" | awk '{ $1=toupper(substr($1,1,1)) substr($1,2); print }')"
fi
dest="$parent/$name"
[[ ! -e "$dest" ]] || { echo "refusing to overwrite existing $dest" >&2; exit 1; }
mkdir -p "$parent"

cp -r "$here/template" "$dest"
mkdir -p "$dest/src/kit" "$dest/tools"
cp -r "$here/ui/." "$dest/src/kit/"
cp "$here/lint/token-lint.mjs" "$here/lint/dsw-defined.txt" "$dest/tools/"

year="$(date +%Y)"
# Substitute placeholders in text files only (sed delimiter is \x01 so slashes in values are safe).
while IFS= read -r -d '' file; do
  sed -i \
    -e "s$(printf '\001')__PKG__$(printf '\001')${pkg}$(printf '\001')g" \
    -e "s$(printf '\001')__ID__$(printf '\001')${name}$(printf '\001')g" \
    -e "s$(printf '\001')__TITLE__$(printf '\001')${title}$(printf '\001')g" \
    -e "s$(printf '\001')__AUTHOR__$(printf '\001')${author}$(printf '\001')g" \
    -e "s$(printf '\001')__YEAR__$(printf '\001')${year}$(printf '\001')g" "$file"
done < <(find "$dest" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' -o -name '*.yml' -o -name '*.md' -o -name 'LICENSE' -o -name 'NOTICE' -o -name '*.mjs' -o -name '*.svg' \) -print0)

if grep -rn '__[A-Z]*__' "$dest" --include='*' -l >/dev/null 2>&1; then
  echo "warning: unreplaced placeholders remain:" >&2
  grep -rn '__\(PKG\|ID\|TITLE\|AUTHOR\|YEAR\)__' "$dest" || true
fi

if [[ $install -eq 1 ]]; then
  (cd "$dest" && pnpm install --silent)
fi
if [[ $git_init -eq 1 ]]; then
  (cd "$dest" && git init -q && git add -A && git commit -qm "Initial commit from dsh-kit template" || true)
fi

cat <<MSG
Created $pkg in $dest
Next:
  cd $dest && pnpm run check        # typecheck, lint + token lint, tests, build, artifact check
  # only after the build succeeds (lib/client.js exists):
  dsh plugin --profile <profile> add "$pkg@link:$dest"   # then restart DSH
MSG
