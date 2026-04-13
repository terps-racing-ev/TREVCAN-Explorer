#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_PATH="${SCRIPT_DIR}/trevcan-explorer.service.example"
SERVICE_NAME="trevcan-explorer.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"
CURRENT_USER="$(id -un)"
CURRENT_GROUP="$(id -gn)"
CURRENT_HOME="${HOME}"
CURRENT_PATH="${PATH}"

escape_for_sed() {
    printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl is required to install the service." >&2
    exit 1
fi

if [[ ! -f "${TEMPLATE_PATH}" ]]; then
    echo "Service template not found: ${TEMPLATE_PATH}" >&2
    exit 1
fi

if [[ -z "${PYTHON_BIN}" || ! -x "${PYTHON_BIN}" ]]; then
    echo "python3 was not found in PATH." >&2
    exit 1
fi

TMP_SERVICE_FILE="$(mktemp)"
trap 'rm -f "${TMP_SERVICE_FILE}"' EXIT

sed \
    -e "s|__USER__|$(escape_for_sed "${CURRENT_USER}")|g" \
    -e "s|__GROUP__|$(escape_for_sed "${CURRENT_GROUP}")|g" \
    -e "s|__WORKDIR__|$(escape_for_sed "${REPO_ROOT}")|g" \
    -e "s|__HOME__|$(escape_for_sed "${CURRENT_HOME}")|g" \
    -e "s|__PATH__|$(escape_for_sed "${CURRENT_PATH}")|g" \
    -e "s|__PYTHON__|$(escape_for_sed "${PYTHON_BIN}")|g" \
    "${TEMPLATE_PATH}" > "${TMP_SERVICE_FILE}"

echo "Installing ${SERVICE_NAME} to ${SERVICE_PATH}"
sudo install -m 0644 "${TMP_SERVICE_FILE}" "${SERVICE_PATH}"
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"

echo "Service installed and started."
echo "Check status with: sudo systemctl status ${SERVICE_NAME}"
echo "Follow logs with: sudo journalctl -u ${SERVICE_NAME} -f"