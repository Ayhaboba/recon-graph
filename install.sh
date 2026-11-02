#!/bin/sh
# recon-graph installer. POSIX sh / dash compatible.
set -eu

NODE_MIN_MAJOR=22
NODE_MIN_MINOR=5
NODE_LOCAL_DIR="$HOME/.local/node"
NODE_MARKER="$NODE_LOCAL_DIR/.node-installed-by-recon"
NODE_DIST_URL="https://nodejs.org/dist/latest-v22.x/"

usage() {
    cat <<'EOF'
Usage: sh install.sh [--check] [--help]

Options:
  --check   run environment checks only (no downloads, no npm install, no tests)
  --help    show this help

Install path:
  1. verify Node.js >= 22.5 (or install Node 22.x into $HOME/.local/node)
  2. npm install --no-audit --no-fund
  3. run lib/db.js --self-test and tests/stage0-smoke.js

Linux is the supported auto-install target; on other systems install
Node.js >= 22.5 manually first.
EOF
}

info() {
    printf '%s\n' "$*"
}

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

version_ok() {
    _ver=$1
    case "$_ver" in
        ''|*[!0-9.]*) return 1 ;;
    esac
    case "$_ver" in
        *.*) ;;
        *) return 1 ;;
    esac
    _major=${_ver%%.*}
    _rest=${_ver#*.}
    _minor=${_rest%%.*}
    case "$_major" in ''|*[!0-9]*) return 1 ;; esac
    case "$_minor" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$_major" -gt "$NODE_MIN_MAJOR" ]; then
        return 0
    fi
    if [ "$_major" -eq "$NODE_MIN_MAJOR" ] && [ "$_minor" -ge "$NODE_MIN_MINOR" ]; then
        return 0
    fi
    return 1
}

download() {
    _url=$1
    _out=$2
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$_url" -o "$_out"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "$_url" -O "$_out"
    else
        return 1
    fi
}

install_local_node() {
    info "Node.js >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} not found; installing latest Node 22.x into $NODE_LOCAL_DIR"

    if [ "$(uname -s)" != "Linux" ]; then
        fail "Automatic Node install supports Linux only. Install Node.js >= 22.5 manually: https://nodejs.org/en/download"
    fi

    _arch=$(uname -m)
    case "$_arch" in
        x86_64|amd64) _node_arch=linux-x64 ;;
        aarch64|arm64) _node_arch=linux-arm64 ;;
        *) fail "Unsupported CPU architecture '$_arch'. Download Node.js >= 22.5 manually: $NODE_DIST_URL" ;;
    esac

    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        fail "Neither curl nor wget is available. Download Node.js >= 22.5 manually: $NODE_DIST_URL"
    fi

    _tmp=$(mktemp -d "${TMPDIR:-/tmp}/recon-node.XXXXXX")
    trap 'rm -rf "$_tmp"' 0 1 2 15

    _shasums="$_tmp/SHASUMS256.txt"
    if ! download "${NODE_DIST_URL}SHASUMS256.txt" "$_shasums"; then
        fail "Could not download Node checksums. Download Node.js >= 22.5 manually: $NODE_DIST_URL"
    fi

    _tarball=$(awk -v s="-$_node_arch.tar.gz" 'index($2, s) { print $2; exit }' "$_shasums")
    if [ -z "$_tarball" ]; then
        fail "No Node 22.x $_node_arch tarball found at $NODE_DIST_URL. Download manually."
    fi

    info "Downloading $_tarball"
    if ! download "${NODE_DIST_URL}${_tarball}" "$_tmp/$_tarball"; then
        fail "Node download failed. Download Node.js >= 22.5 manually: $NODE_DIST_URL"
    fi

    _expected=$(awk -v f="$_tarball" '$2 == f { print $1; exit }' "$_shasums")
    if [ -n "$_expected" ] && command -v sha256sum >/dev/null 2>&1; then
        _actual=$(sha256sum "$_tmp/$_tarball" | awk '{ print $1 }')
        if [ "$_expected" != "$_actual" ]; then
            fail "Node tarball checksum mismatch (expected $_expected, got $_actual)"
        fi
    fi

    mkdir -p "$HOME/.local"
    rm -rf "$HOME/.local/node.new"
    mkdir -p "$HOME/.local/node.new"
    if ! tar -xzf "$_tmp/$_tarball" -C "$HOME/.local/node.new" --strip-components=1; then
        rm -rf "$HOME/.local/node.new"
        fail "Failed to extract Node tarball"
    fi
    rm -rf "$NODE_LOCAL_DIR"
    mv "$HOME/.local/node.new" "$NODE_LOCAL_DIR"
    printf 'Installed by recon-graph install.sh on %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$NODE_MARKER"

    PATH="$NODE_LOCAL_DIR/bin:$PATH"
    export PATH

    info "Node installed: $("$NODE_LOCAL_DIR/bin/node" -v)"
    info "Add this line to your ~/.profile (or shell rc) to keep Node on PATH:"
    info "export PATH=\"\$HOME/.local/node/bin:\$PATH\""

    trap - 0 1 2 15
    rm -rf "$_tmp"
}

CHECK_ONLY=0
for _arg in "$@"; do
    case "$_arg" in
        --check) CHECK_ONLY=1 ;;
        --help|-h) usage; exit 0 ;;
        *) printf 'install.sh: unknown option: %s\n\n' "$_arg" >&2; usage >&2; exit 2 ;;
    esac
done

_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$_script_dir"

NODE_OK=0
_have_node=""
if command -v node >/dev/null 2>&1; then
    _have_node=$(node -v 2>/dev/null | sed 's/^v//' || true)
    if version_ok "$_have_node"; then
        NODE_OK=1
    fi
fi

if [ "$NODE_OK" -eq 0 ] && [ -x "$NODE_LOCAL_DIR/bin/node" ]; then
    _local_ver=$("$NODE_LOCAL_DIR/bin/node" -v 2>/dev/null | sed 's/^v//' || true)
    if version_ok "$_local_ver"; then
        PATH="$NODE_LOCAL_DIR/bin:$PATH"
        export PATH
        NODE_OK=1
        _have_node=$_local_ver
        info "Using installer-managed Node $_local_ver at $NODE_LOCAL_DIR"
    fi
fi

if [ "$NODE_OK" -eq 0 ]; then
    if [ "$CHECK_ONLY" -eq 1 ]; then
        if [ -n "$_have_node" ]; then
            fail "Node.js $_have_node is older than ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}. Run 'sh install.sh' (without --check) to install Node 22.x, or install manually: $NODE_DIST_URL"
        fi
        fail "Node.js not found (need >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}). Run 'sh install.sh' (without --check) to install it, or download: $NODE_DIST_URL"
    fi
    install_local_node
    _have_node=$(node -v 2>/dev/null | sed 's/^v//' || true)
    if ! version_ok "$_have_node"; then
        fail "Node installation did not produce a usable Node >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} on PATH"
    fi
fi

if ! command -v npm >/dev/null 2>&1; then
    fail "npm not found on PATH (Node.js usually ships it). Reinstall Node >= 22.5 or fix PATH."
fi

info "Node.js: $(node -v) | npm: $(npm -v)"
info "Project: $_script_dir"

if [ "$CHECK_ONLY" -eq 1 ]; then
    [ -f package.json ] || fail "package.json not found in $_script_dir"
    [ -f lib/db.js ] || fail "lib/db.js not found"
    [ -f tests/stage0-smoke.js ] || fail "tests/stage0-smoke.js not found"
    [ -f lists/common.txt ] || fail "lists/common.txt not found"
    [ -d web/vendor ] || fail "web/vendor not found"
    info "Check OK: environment and required files present."
    info "No network install was performed. Run 'sh install.sh' to install dependencies and run self-tests."
    exit 0
fi

info "Installing dependencies (ws)..."
if ! npm install --no-audit --no-fund; then
    fail "npm install failed. Check network/proxy settings, then rerun: sh install.sh"
fi

if command -v sqlite3 >/dev/null 2>&1; then
    info "sqlite3: found ($(sqlite3 --version 2>/dev/null | cut -d' ' -f1)) - optional, not required"
else
    info "sqlite3: not found - optional, not required (the app uses built-in node:sqlite)"
fi

if command -v chromium >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1 || command -v firefox >/dev/null 2>&1; then
    info "browser: found - UI will work at http://127.0.0.1:8931/"
else
    info "browser: none of chromium/google-chrome/firefox found - install one to use the UI"
fi

info "Running database self-test..."
if ! node lib/db.js --self-test; then
    printf '\n--- diagnostics ---\n' >&2
    printf 'node: %s\n' "$(node -v 2>&1 || true)" >&2
    printf 'npm: %s\n' "$(npm -v 2>&1 || true)" >&2
    printf 'cwd: %s\n' "$PWD" >&2
    printf 'platform: %s %s\n' "$(uname -s 2>/dev/null || true)" "$(uname -m 2>/dev/null || true)" >&2
    if [ -d node_modules ]; then
        printf 'node_modules: present\n' >&2
    else
        printf 'node_modules: missing\n' >&2
    fi
    fail "Database self-test failed"
fi

info "Running stage 0 smoke test..."
if ! node tests/stage0-smoke.js; then
    printf '\n--- diagnostics ---\n' >&2
    printf 'node: %s\n' "$(node -v 2>&1 || true)" >&2
    printf 'cwd: %s\n' "$PWD" >&2
    printf 'node_modules: ' >&2
    if [ -d node_modules ]; then
        printf 'present\n' >&2
    else
        printf 'missing\n' >&2
    fi
    fail "Stage 0 smoke test failed"
fi

for _f in bin/scanner.js bin/server.js; do
    [ -f "$_f" ] || fail "$_f not found"
    _first=$(head -n 1 "$_f")
    case "$_first" in
        '#!'*) chmod +x "$_f" ;;
    esac
done

cat <<'EOF'

Install complete.

Next steps:
  node bin/scanner.js https://example.com/ --max-depth 3 --wordlist lists/common.txt
  node bin/server.js
  # open http://127.0.0.1:8931/
EOF
