#!/usr/bin/env bash
# Installer for official Prime Agent Rust-based Linux release archives.
# Requires an installed Python >=3.11 and access to a Python package mirror.
# Downloads no release artifacts, uv binaries, or Python interpreters.
# Usage: bash install-prime-agent-offline.sh ARCHIVE --index-url https://mirror.example/simple
set -Eeuo pipefail

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'HELP'
Usage: bash install-prime-agent-offline.sh ARCHIVE [OPTIONS]

Install an official Prime Agent Rust Linux tar.gz release without GitHub access.
Required: Python >=3.11 already installed, and a reachable Python package mirror
containing runtime dependencies and build backends (including hatchling).
uv is optional; without it, Python's venv/ensurepip support is required.

Options:
  --index-url URL   Python mirror's /simple URL (or PIP_INDEX_URL,
                    UV_DEFAULT_INDEX, UV_INDEX_URL)
  --python PATH     Installed Python interpreter (or PRIME_AGENT_PYTHON)
  --prefix DIR      Installation prefix (default: $HOME/.local)
  --help            Show this help

The launcher pins the prepared kernel Python, bypassing automatic downloads.
The archive selects the installed version; supply the latest release archive
to install the latest version. Model providers still require connectivity.
HELP
}

ARCHIVE=""
INDEX_URL=${PIP_INDEX_URL:-${UV_DEFAULT_INDEX:-${UV_INDEX_URL:-}}}
PREFIX=${PRIME_AGENT_INSTALL_PREFIX:-$HOME/.local}
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --index-url|--python|--prefix)
            [[ $# -ge 2 && -n "$2" ]] || die "$1 requires a value."
            case "$1" in
                --index-url) INDEX_URL=$2 ;;
                --python) PRIME_AGENT_PYTHON=$2 ;;
                --prefix) PREFIX=$2 ;;
            esac
            shift 2 ;;
        -*) die "Unknown option: $1" ;;
        *) [[ -z "$ARCHIVE" ]] || die "Supply exactly one release archive."
           ARCHIVE=$1; shift ;;
    esac
done
[[ -n "$ARCHIVE" ]] || { usage >&2; exit 2; }
[[ -n "$INDEX_URL" ]] || die "Set --index-url to your Python mirror's /simple URL."
[[ "$PREFIX" == /* ]] || die "--prefix must be an absolute path."

[[ -f "$ARCHIVE" && -r "$ARCHIVE" ]] || die "Cannot read archive: $ARCHIVE"
[[ $(uname -s) == Linux ]] || die "This installer supports Linux only."

case "$(uname -m)" in
    x86_64)  PLATFORM=linux-x64 ;;
    aarch64) PLATFORM=linux-arm64 ;;
    *) die "Unsupported CPU architecture: $(uname -m)" ;;
esac

ARCHIVE_NAME=$(basename -- "$ARCHIVE")
if [[ "$ARCHIVE_NAME" =~ ^prime-agent-(.+)-${PLATFORM}\.tar\.gz$ ]]; then
    RELEASE_VERSION=${BASH_REMATCH[1]}
else
    die "Expected prime-agent-VERSION-${PLATFORM}.tar.gz, got: $ARCHIVE_NAME"
fi
log "Installing Prime Agent release: $RELEASE_VERSION ($PLATFORM)"

# No hardcoded SHA-256 check: the same script can install future releases.
# The archive is still checked for extraction errors and expected payload paths.

# Use only the selected mirror, including isolated build dependencies.
# Do not print the URL: mirror credentials may be embedded in it.
export PIP_INDEX_URL="$INDEX_URL" UV_DEFAULT_INDEX="$INDEX_URL" UV_INDEX_URL="$INDEX_URL"
export PIP_CONFIG_FILE=/dev/null UV_PYTHON_DOWNLOADS=never
unset PIP_EXTRA_INDEX_URL UV_EXTRA_INDEX_URL UV_INDEX UV_CONFIG_FILE
unset PYTHONPATH PYTHONHOME PYTHONUSERBASE
export PYTHONNOUSERSITE=1
log "Using the selected Python package mirror; interpreter downloads are disabled."

# Select an already-installed Python >= 3.11, never download one.
PYTHON_BIN=""
if [[ -n ${PRIME_AGENT_PYTHON:-} ]]; then
    PYTHON_CANDIDATES=("$PRIME_AGENT_PYTHON")
else
    PYTHON_CANDIDATES=(python3 python3.13 python3.12 python3.11 python3.14)
fi
for candidate in "${PYTHON_CANDIDATES[@]}"; do
    if command -v "$candidate" >/dev/null 2>&1 && \
       "$candidate" -I -c 'import sys; assert sys.version_info >= (3, 11)' 2>/dev/null; then
        PYTHON_BIN=$(command -v "$candidate")
        break
    fi
done
[[ -n "$PYTHON_BIN" ]] || die "Python >=3.11 is required. Install it locally or set PRIME_AGENT_PYTHON to its path."
log "Using Python: $PYTHON_BIN ($("$PYTHON_BIN" --version 2>&1))"

BIN_DIR="$PREFIX/bin"
SHARE_DIR="$PREFIX/share"
INSTALL_DIR="$SHARE_DIR/prime-agent"
LAUNCHER="$BIN_DIR/prime-agent"
mkdir -p "$BIN_DIR" "$SHARE_DIR"

STAGE_DIR=$(mktemp -d "$SHARE_DIR/.prime-agent-stage.XXXXXXXX")
TMP_LAUNCHER=""
VENV_DIR=""
KEEP_VENV=0
cleanup() {
    if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then rm -rf -- "$STAGE_DIR"; fi
    if [[ -n "$TMP_LAUNCHER" && -e "$TMP_LAUNCHER" ]]; then rm -f -- "$TMP_LAUNCHER"; fi
    if [[ "$KEEP_VENV" == 0 && -n "$VENV_DIR" && -d "$VENV_DIR" ]]; then rm -rf -- "$VENV_DIR"; fi
}
trap cleanup EXIT

log "Extracting $(basename "$ARCHIVE")"
tar -xzf "$ARCHIVE" -C "$STAGE_DIR" --no-same-owner || die "Archive extraction failed."
[[ -f "$STAGE_DIR/prime-agent" && -f "$STAGE_DIR/prime-agent-runtime/pyproject.toml" && -d "$STAGE_DIR/skills" ]] || \
    die "Archive must contain prime-agent, prime-agent-runtime/pyproject.toml, and skills/ at its root."
SKILL_PACKAGES=()
for skill_dir in "$STAGE_DIR"/skills/*/; do
    [[ -f "$skill_dir/pyproject.toml" ]] && SKILL_PACKAGES+=("$skill_dir")
done
chmod +x "$STAGE_DIR/prime-agent"
"$STAGE_DIR/prime-agent" --version || die "Rust executable cannot run on this Linux host (check glibc/architecture)."

# A fresh, permanently located venv avoids stale packages and leaves the previous
# installation usable if setup fails. Never relocate a populated venv.
mkdir -p "$SHARE_DIR/prime-agent-kernels"
VENV_DIR=$(mktemp -d "$SHARE_DIR/prime-agent-kernels/$RELEASE_VERSION.XXXXXXXX")
log "Preparing Python environment: $VENV_DIR"
if command -v uv >/dev/null 2>&1; then
    log "Found uv: creating a venv with the installed system Python (no Python downloads)"
    uv --no-config venv "$VENV_DIR" --python "$PYTHON_BIN" --no-python-downloads
else
    log "uv not found: using Python's built-in venv"
    "$PYTHON_BIN" -I -m venv "$VENV_DIR" || \
        die "python -m venv failed. Install the matching python3-venv/ensurepip package locally."
fi

# Rust's kernel probe requires these twelve standard extras, plus dill.
# The local runtime declares its own dependencies (notably mcp and tyro).
EXTRAS=(
    dill requests httpx pyyaml tomli python-dotenv pandas numpy scipy
    beautifulsoup4 lxml pydantic tyro
)

log "Installing Python packages with the selected package manager"
if command -v uv >/dev/null 2>&1; then
    uv --no-config pip install --python "$VENV_DIR/bin/python" \
        "$STAGE_DIR/prime-agent-runtime" "${SKILL_PACKAGES[@]}" "${EXTRAS[@]}" || \
        die "uv installation failed. Confirm the mirror contains wheels/build dependencies (e.g. hatchling)."
else
    "$VENV_DIR/bin/python" -I -m pip --version >/dev/null 2>&1 || \
        die "pip is unavailable in the venv. Install the python3-venv/ensurepip package locally."
    "$VENV_DIR/bin/python" -I -m pip install \
        "$STAGE_DIR/prime-agent-runtime" "${SKILL_PACKAGES[@]}" "${EXTRAS[@]}" || \
        die "pip installation failed; check your mirror's dependencies, wheels, and build backends."
fi

log "Checking Python runtime imports"
"$VENV_DIR/bin/python" -I - <<'PY' || die "One or more Python runtime packages cannot be imported."
import importlib
modules = (
    'rlm.repl', 'mcp', 'dill', 'requests', 'httpx', 'yaml', 'tomli',
    'dotenv', 'pandas', 'numpy', 'scipy', 'bs4', 'lxml', 'pydantic', 'tyro'
)
for module in modules:
    importlib.import_module(module)
print('All expected Python imports succeeded.')
PY

# This is the CLI's own verification of PRIME_AGENT_KERNEL_PYTHON.
log "Running Prime Agent kernel bootstrap check"
PRIME_AGENT_KERNEL_PYTHON="$VENV_DIR/bin/python" \
    "$STAGE_DIR/prime-agent" --prime-agent-bootstrap || \
    die "Prime Agent rejected the Python environment; existing CLI installation was not replaced."

log "Verifying persistent Python kernel execution"
"$VENV_DIR/bin/python" -I - <<'PY' || die "Kernel execution failed; existing CLI installation was not replaced."
import json
import os
import subprocess
import sys
import tempfile

requests = [
    {"type": "execute", "id": "seed", "code": "offline_install_value = 21"},
    {"type": "execute", "id": "verify", "code": "offline_install_value * 2"},
    {"type": "shutdown"},
]
env = os.environ.copy()
for key in ("PRIME_AGENT_KERNEL_OWNER_PID", "RLM_SESSION_ID"):
    env.pop(key, None)
with tempfile.TemporaryDirectory() as cwd:
    result = subprocess.run(
        [sys.executable, "-I", "-m", "rlm.repl"],
        input="".join(json.dumps(request) + "\n" for request in requests),
        capture_output=True, text=True, timeout=30, check=True, cwd=cwd, env=env,
    )
events = [json.loads(line) for line in result.stdout.splitlines()]
assert any(event.get("event") == "ready" for event in events), events
for request_id in ("seed", "verify"):
    assert any(
        event.get("event") == "done" and event.get("id") == request_id
        and event.get("status") == "ok" for event in events
    ), events
assert any(
    event.get("event") == "result" and event.get("id") == "verify"
    and event.get("text") == "42" for event in events
), events
print("Kernel started and preserved state across two cells (21 * 2 = 42).")
PY

log "Publishing Prime Agent to $INSTALL_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
    BACKUP="$SHARE_DIR/prime-agent.backup-$STAMP"
    mv -- "$INSTALL_DIR" "$BACKUP"
    log "Previous installation preserved at: $BACKUP"
fi
if ! mv -- "$STAGE_DIR" "$INSTALL_DIR"; then
    if [[ -n ${BACKUP:-} ]]; then mv -- "$BACKUP" "$INSTALL_DIR"; fi
    die "Failed to install the release payload."
fi
STAGE_DIR=""

# The launcher carries the Python override: no .bashrc edits required.
TMP_LAUNCHER=$(mktemp "$BIN_DIR/.prime-agent-launcher.XXXXXXXX")
{
    printf '#!/usr/bin/env bash\n'
    printf 'if [[ -z ${PRIME_AGENT_KERNEL_PYTHON:-} ]]; then\n'
    printf '    export PRIME_AGENT_KERNEL_PYTHON=%q\n' "$VENV_DIR/bin/python"
    printf 'fi\n'
    printf 'exec %q "$@"\n' "$INSTALL_DIR/prime-agent"
} > "$TMP_LAUNCHER"
chmod +x "$TMP_LAUNCHER"
if [[ -e "$LAUNCHER" || -L "$LAUNCHER" ]]; then
    OLD_LAUNCHER="$BIN_DIR/prime-agent.backup-$STAMP"
    mv -- "$LAUNCHER" "$OLD_LAUNCHER"
    log "Previous launcher preserved at: $OLD_LAUNCHER"
fi
mv -- "$TMP_LAUNCHER" "$LAUNCHER"
TMP_LAUNCHER=""
KEEP_VENV=1

log "Installation complete"
"$LAUNCHER" --version
printf 'Run: %s\n' "$LAUNCHER"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    printf '\nFor the prime-agent command to work without a full path, add this to ~/.bashrc:\n'
    printf '  export PATH=%q:"$PATH"\n' "$BIN_DIR"
fi
printf '\nNote: the LLM provider must be reachable from this offline machine.\n'
