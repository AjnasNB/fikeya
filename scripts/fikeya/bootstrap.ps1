# SPDX-License-Identifier: AGPL-3.0-or-later

[CmdletBinding(PositionalBinding = $false)]
param(
	[Alias('check-only')]
	[switch]$CheckOnly,

	[Alias('root')]
	[string]$ProjectRoot,

	[Alias('cache-root')]
	[string]$CacheRoot,

	[switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Help) {
	Write-Output 'Usage: pwsh -File scripts/fikeya/bootstrap.ps1 [--check-only] [--root PATH] [--cache-root PATH]'
	exit 0
}

$scriptDirectory = Split-Path -Parent $PSCommandPath
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
	$ProjectRoot = Join-Path $scriptDirectory '..\..'
}

function Find-PythonCommand {
	$python = Get-Command python -ErrorAction SilentlyContinue
	if ($null -ne $python) {
		return @($python.Source)
	}
	$launcher = Get-Command py -ErrorAction SilentlyContinue
	if ($null -ne $launcher) {
		return @($launcher.Source, '-3')
	}
	throw 'Python 3.10 or newer was not found on PATH.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
	throw 'Node.js was not found on PATH.'
}
$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($null -eq $npm) {
	throw 'npm was not found on PATH.'
}

$pythonCommand = @(Find-PythonCommand)
$pythonExecutable = $pythonCommand[0]
$pythonPrefix = @($pythonCommand | Select-Object -Skip 1)
$pythonVersion = (& $pythonExecutable @pythonPrefix --version 2>&1 | Out-String).Trim()
$nodeVersion = (& $node.Source --version 2>&1 | Out-String).Trim()
$npmVersion = (& $npm.Source --version 2>&1 | Out-String).Trim()
$support = Join-Path $scriptDirectory 'bootstrap_support.py'

$validationArguments = @(
	$support,
	'validate',
	'--root', $ProjectRoot,
	'--node-version', $nodeVersion,
	'--npm-version', $npmVersion,
	'--python-version', $pythonVersion
)
if (-not [string]::IsNullOrWhiteSpace($CacheRoot)) {
	$validationArguments += @('--cache-root', $CacheRoot)
}
& $pythonExecutable @pythonPrefix @validationArguments
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}

$cacheArguments = @($support, 'cache-path', '--root', $ProjectRoot)
if (-not [string]::IsNullOrWhiteSpace($CacheRoot)) {
	$cacheArguments += @('--cache-root', $CacheRoot)
}
$cachePath = (& $pythonExecutable @pythonPrefix @cacheArguments 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
	Write-Error $cachePath
	exit $LASTEXITCODE
}

if ($CheckOnly) {
	$runtimeState = if (Test-Path -LiteralPath (Join-Path $cachePath 'runtime\Scripts\python.exe')) { 'present' } else { 'not installed' }
	Write-Output "[state] isolated runtime: $runtimeState"
	Write-Output '[ready] check-only completed without filesystem or network changes'
	exit 0
}

$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$runtimeSource = Join-Path $resolvedRoot 'fikeya-runtime'
$constraints = Join-Path $scriptDirectory 'runtime-constraints.txt'
$runtimeEnvironment = Join-Path $cachePath 'runtime'
$runtimePython = Join-Path $runtimeEnvironment 'Scripts\python.exe'

Write-Output '[1/5] Preparing the isolated runtime environment'
New-Item -ItemType Directory -Force -Path $cachePath | Out-Null
if (-not (Test-Path -LiteralPath $runtimePython -PathType Leaf)) {
	& $pythonExecutable @pythonPrefix -m venv $runtimeEnvironment
	if ($LASTEXITCODE -ne 0) {
		exit $LASTEXITCODE
	}
}

$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PIP_NO_INPUT = '1'
Write-Output '[2/5] Installing Fikeya Runtime with the Azure identity extra'
& $runtimePython -m pip install --no-input --disable-pip-version-check --constraint $constraints "$runtimeSource[azure]"
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}

$env:npm_config_cache = Join-Path $cachePath 'npm-cache'
$protocolPath = Join-Path $resolvedRoot 'packages\fikeya-protocol'
$sidecarPath = Join-Path $resolvedRoot 'integrations\qarinah-sidecar'
Write-Output '[3/5] Installing the locked Fikeya protocol dependencies'
& $npm.Source --prefix $protocolPath ci --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}
& $npm.Source --prefix $protocolPath test
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}

Write-Output '[4/5] Installing the locked Qarinah sidecar dependencies'
& $npm.Source --prefix $sidecarPath ci --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}
& $npm.Source --prefix $sidecarPath test
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}

Write-Output '[5/5] Verifying the installed bundle and writing its receipt'
& $runtimePython -m fikeya_runtime.cli --help | Out-Null
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}
$receiptArguments = @(
	$support,
	'write-receipt',
	'--root', $resolvedRoot,
	'--node-version', $nodeVersion,
	'--python-version', (& $runtimePython --version 2>&1 | Out-String).Trim()
)
if (-not [string]::IsNullOrWhiteSpace($CacheRoot)) {
	$receiptArguments += @('--cache-root', $CacheRoot)
}
$receipt = (& $runtimePython @receiptArguments 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
	Write-Error $receipt
	exit $LASTEXITCODE
}

Write-Output "[ready] Fikeya Runtime: $runtimePython"
Write-Output "[ready] Verification receipt: $receipt"
Write-Output '[ready] No provider credentials were requested or stored'
