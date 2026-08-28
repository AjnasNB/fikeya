#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

usage() {
	printf '%s\n' 'Usage: sh scripts/fikeya/bootstrap.sh [--check-only] [--root PATH] [--cache-root PATH]'
}

CHECK_ONLY=0
PROJECT_ROOT=''
CACHE_ROOT=''

while [ "$#" -gt 0 ]; do
	case "$1" in
		--check-only)
			CHECK_ONLY=1
			shift
			;;
		--root)
			[ "$#" -ge 2 ] || { printf '%s\n' '[error] --root requires a path' >&2; exit 2; }
			PROJECT_ROOT=$2
			shift 2
			;;
		--cache-root)
			[ "$#" -ge 2 ] || { printf '%s\n' '[error] --cache-root requires a path' >&2; exit 2; }
			CACHE_ROOT=$2
			shift 2
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			printf '[error] unknown option: %s\n' "$1" >&2
			usage >&2
			exit 2
			;;
	esac
done

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if [ -z "$PROJECT_ROOT" ]; then
	PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/../.." && pwd -P)
fi
SUPPORT=$SCRIPT_DIRECTORY/bootstrap_support.py

PYTHON=''
PYTHON_VERSION=''
for candidate in python3 python; do
	if command -v "$candidate" >/dev/null 2>&1; then
		if candidate_version=$("$candidate" --version 2>&1); then
			PYTHON=$candidate
			PYTHON_VERSION=$candidate_version
			break
		fi
	fi
done
if [ -z "$PYTHON" ]; then
	printf '%s\n' '[error] Python 3.10 or newer was not found on PATH.' >&2
	exit 2
fi
command -v node >/dev/null 2>&1 || { printf '%s\n' '[error] Node.js was not found on PATH.' >&2; exit 2; }
command -v npm >/dev/null 2>&1 || { printf '%s\n' '[error] npm was not found on PATH.' >&2; exit 2; }

NODE_VERSION=$(node --version 2>&1)
NPM_VERSION=$(npm --version 2>&1)

set -- "$SUPPORT" validate --root "$PROJECT_ROOT" \
	--node-version "$NODE_VERSION" --npm-version "$NPM_VERSION" --python-version "$PYTHON_VERSION"
if [ -n "$CACHE_ROOT" ]; then
	set -- "$@" --cache-root "$CACHE_ROOT"
fi
$PYTHON "$@"

set -- "$SUPPORT" cache-path --root "$PROJECT_ROOT"
if [ -n "$CACHE_ROOT" ]; then
	set -- "$@" --cache-root "$CACHE_ROOT"
fi
CACHE_PATH=$($PYTHON "$@")

if [ "$CHECK_ONLY" -eq 1 ]; then
	if [ -x "$CACHE_PATH/runtime/bin/python" ]; then
		RUNTIME_STATE=present
	else
		RUNTIME_STATE='not installed'
	fi
	printf '[state] isolated runtime: %s\n' "$RUNTIME_STATE"
	printf '%s\n' '[ready] check-only completed without filesystem or network changes'
	exit 0
fi

PROJECT_ROOT=$(CDPATH= cd -- "$PROJECT_ROOT" && pwd -P)
AGENT_CORE_SOURCE=$PROJECT_ROOT/fikeya-agent-core
RUNTIME_SOURCE=$PROJECT_ROOT/fikeya-runtime
CONSTRAINTS=$SCRIPT_DIRECTORY/runtime-constraints.txt
RUNTIME_ENVIRONMENT=$CACHE_PATH/runtime
RUNTIME_PYTHON=$RUNTIME_ENVIRONMENT/bin/python

printf '%s\n' '[1/5] Preparing the isolated runtime environment'
mkdir -p -- "$CACHE_PATH"
if [ ! -x "$RUNTIME_PYTHON" ]; then
	$PYTHON -m venv "$RUNTIME_ENVIRONMENT"
fi

export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_NO_INPUT=1
printf '%s\n' '[2/5] Installing Fikeya Agent Core and Runtime with Azure identity and browser support'
"$RUNTIME_PYTHON" -m pip install --no-input --disable-pip-version-check \
	--constraint "$CONSTRAINTS" "$AGENT_CORE_SOURCE" "$RUNTIME_SOURCE[azure,browser]"
"$RUNTIME_PYTHON" -m playwright install chromium-headless-shell

export npm_config_cache=$CACHE_PATH/npm-cache
printf '%s\n' '[3/5] Installing the locked Fikeya protocol dependencies'
npm --prefix "$PROJECT_ROOT/packages/fikeya-protocol" ci --ignore-scripts --no-audit --no-fund
npm --prefix "$PROJECT_ROOT/packages/fikeya-protocol" test

printf '%s\n' '[4/5] Installing the locked Qarinah sidecar dependencies'
npm --prefix "$PROJECT_ROOT/integrations/qarinah-sidecar" ci --ignore-scripts --no-audit --no-fund
npm --prefix "$PROJECT_ROOT/integrations/qarinah-sidecar" test

printf '%s\n' '[5/5] Verifying the installed bundle and writing its receipt'
"$RUNTIME_PYTHON" -m fikeya_runtime.cli --help >/dev/null
RUNTIME_VERSION=$("$RUNTIME_PYTHON" --version 2>&1)
set -- "$SUPPORT" write-receipt --root "$PROJECT_ROOT" \
	--node-version "$NODE_VERSION" --python-version "$RUNTIME_VERSION"
if [ -n "$CACHE_ROOT" ]; then
	set -- "$@" --cache-root "$CACHE_ROOT"
fi
RECEIPT=$("$RUNTIME_PYTHON" "$@")

printf '[ready] Fikeya Runtime: %s\n' "$RUNTIME_PYTHON"
printf '[ready] Verification receipt: %s\n' "$RECEIPT"
printf '%s\n' '[ready] No provider credentials were requested or stored'
