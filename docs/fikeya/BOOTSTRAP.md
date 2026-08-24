# Fikeya Developer-Alpha Bootstrap

The checked-in bootstrap installs and verifies Fikeya's independently testable runtime components from a trusted source checkout. It does not download or execute a remote shell script, request administrator elevation, initialize a workspace, contact a model provider, or ask for credentials.

## Prerequisites

- Node.js 22.13 or newer on the Node 22 line, Node 24, or Node 26
- npm available beside Node.js
- Python 3.10 or newer on the Python 3 line
- A local Fikeya source checkout
- Network access only for the full dependency installation

Run the network-free, read-only preflight first:

```powershell
pwsh -NoProfile -File scripts/fikeya/bootstrap.ps1 --check-only
```

Windows PowerShell 5.1 can use `-CheckOnly` instead of `--check-only`. On macOS or Linux:

```sh
sh scripts/fikeya/bootstrap.sh --check-only
```

The preflight validates the checkout markers, component manifest, dependency lockfiles, tool versions, and cache target. It reports whether this checkout already has an isolated runtime but does not create directories or make network requests.

## Install and Verify

From the repository root on Windows:

```powershell
pwsh -NoProfile -File scripts/fikeya/bootstrap.ps1
```

On macOS or Linux:

```sh
sh scripts/fikeya/bootstrap.sh
```

The bootstrap performs five bounded steps:

1. Creates a Python virtual environment in the current user's cache, isolated by a content-free hash of the checkout path.
2. Installs the local `fikeya-runtime` package with the Azure identity extra under the checked-in dependency constraints.
3. Runs `npm ci` and the protocol tests using the protocol lockfile.
4. Runs `npm ci` and the Qarinah sidecar tests using the sidecar lockfile.
5. Verifies the runtime entry point and writes a content-free `verification.json` receipt in the isolated cache.

`npm ci` creates ignored `node_modules` directories inside the two component source directories. npm's download cache and the Python environment stay in the per-checkout cache. The script does not alter global package stores or install a global executable.

At completion, the script prints the absolute path to the isolated Python executable. Use the corresponding `fikeya` entry point in the same virtual environment. The bootstrap deliberately does not add anything to `PATH`.

## Cache Location

The default cache base is:

- Windows: `%LOCALAPPDATA%\Fikeya`
- macOS: `~/Library/Caches/Fikeya`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/Fikeya`

Set a different base with `--cache-root PATH`. Fikeya appends `developer-alpha/<checkout fingerprint>` to the base so two source checkouts never share a writable runtime environment. Filesystem roots and incomplete source checkouts are rejected.

```powershell
pwsh -NoProfile -File scripts/fikeya/bootstrap.ps1 --cache-root D:\FikeyaCache
```

```sh
sh scripts/fikeya/bootstrap.sh --cache-root "$HOME/fikeya-cache"
```

## Credentials and Network Boundaries

No provider key is accepted by the bootstrap, and no provider endpoint is called. Provider configuration is a separate, explicit post-install action through Fikeya Desktop or the runtime CLI. Secrets must enter through the desktop secret store, an operating-system credential, workload identity, or standard input to the documented provider command. They must never be placed in bootstrap arguments or committed files.

The full bootstrap uses the configured Python and npm package indexes to obtain dependencies. This developer-alpha process is reproducible at the component and declared dependency-version level, but it is not an offline, bit-for-bit release bundle. A stable release still needs signed platform artifacts, a sealed wheel and npm artifact set, provenance attestations, and clean-install verification on each supported operating system.

## Bundle Contract

[`components.json`](../../scripts/fikeya/components.json) is the machine-readable build contract. It records the supported runtime lines, source component versions, npm lockfiles, Python constraints, and verification commands. The generated receipt includes only component versions, lockfile digests, interpreter versions, installed Python distribution versions, and a checkout fingerprint. It does not include repository content, prompts, credentials, environment variables, or provider responses.

Bootstrap behavior is tested with the standard library only:

```console
python -m unittest discover -s scripts/fikeya/tests -v
```
