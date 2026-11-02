#!/bin/sh
# recon-graph uninstaller. POSIX sh / dash compatible.
set -eu

NODE_LOCAL_DIR="$HOME/.local/node"
NODE_MARKER="$NODE_LOCAL_DIR/.node-installed-by-recon"

usage() {
    cat <<'EOF'
Usage: sh uninstall.sh [--yes] [--help]

Removes:
  - node_modules/
  - data/ (scan databases and bodies)
  - $HOME/.local/node only if install.sh created it
    (marker file .node-installed-by-recon present)

Options:
  --yes    do not ask for confirmation
  --help   show this help
EOF
}

YES=0
for _arg in "$@"; do
    case "$_arg" in
        --yes|-y) YES=1 ;;
        --help|-h) usage; exit 0 ;;
        *) printf 'uninstall.sh: unknown option: %s\n\n' "$_arg" >&2; usage >&2; exit 2 ;;
    esac
done

_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$_script_dir"

if [ "$YES" -eq 0 ]; then
    printf 'Remove node_modules/, data/ and installer-managed Node (if any) from %s? [y/N] ' "$_script_dir"
    read -r _answer || _answer=""
    case "$_answer" in
        y|Y|yes|YES) ;;
        *) printf 'Aborted.\n'; exit 0 ;;
    esac
fi

if [ -d node_modules ]; then
    rm -rf node_modules
    printf 'Removed: node_modules/\n'
else
    printf 'Not present: node_modules/\n'
fi

if [ -d data ]; then
    rm -rf data
    printf 'Removed: data/\n'
else
    printf 'Not present: data/\n'
fi

if [ -f "$NODE_MARKER" ]; then
    rm -rf "$NODE_LOCAL_DIR"
    printf 'Removed installer-managed Node: %s\n' "$NODE_LOCAL_DIR"
else
    printf 'Left in place: %s (not created by install.sh)\n' "$NODE_LOCAL_DIR"
fi

printf 'Done.\n'
