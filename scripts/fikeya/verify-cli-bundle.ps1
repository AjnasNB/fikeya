[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string]$BundlePath,
	[Parameter(Mandatory = $true)]
	[string]$PublicVersion,
	[Parameter(Mandatory = $true)]
	[string]$PythonVersion,
	[string]$PythonCommand = "python"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$bundle = (Resolve-Path -LiteralPath $BundlePath).Path
$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot ".build"))
$smokeRoot = Join-Path $buildRoot "cli-bundle-smoke-$([guid]::NewGuid().ToString('N'))"
$buildPrefix = $buildRoot.TrimEnd('\') + '\'
if (-not $smokeRoot.StartsWith($buildPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
	throw "CLI bundle smoke directory must remain inside $buildRoot"
}

New-Item -ItemType Directory -Path $smokeRoot | Out-Null
try {
	$bundleRoot = Join-Path $smokeRoot "bundle"
	$venvRoot = Join-Path $smokeRoot "venv"
	Expand-Archive -LiteralPath $bundle -DestinationPath $bundleRoot

	foreach ($prefix in @("fikeya_agent_core-", "fikeya_runtime-", "fikeya_interop-")) {
		$matches = @(Get-ChildItem -LiteralPath $bundleRoot -File -Filter "$prefix*.whl")
		if ($matches.Count -ne 1) {
			throw "Expected one $prefix wheel in the CLI bundle; found $($matches.Count)."
		}
	}
	$installer = Join-Path $bundleRoot "install-fikeya-cli.ps1"
	if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
		throw "The CLI bundle is missing install-fikeya-cli.ps1."
	}

	& $PythonCommand -m venv $venvRoot
	if ($LASTEXITCODE -ne 0) {
		throw "Could not create the isolated CLI verification environment."
	}
	$python = Join-Path $venvRoot "Scripts\python.exe"
	$fikeya = Join-Path $venvRoot "Scripts\fikeya.exe"
	& $installer -PythonCommand $python
	if ($LASTEXITCODE -ne 0) {
		throw "Could not install the shipped Fikeya wheels with Azure support."
	}
	& $python -c "import azure.identity"
	if ($LASTEXITCODE -ne 0) {
		throw "The shipped Fikeya CLI does not include its Azure runtime dependency."
	}

	$reportedVersion = @(& $fikeya --version)
	$expectedCliVersion = "fikeya $PythonVersion"
	if ($LASTEXITCODE -ne 0 -or $reportedVersion.Count -lt 1 -or $reportedVersion[0].Trim() -cne $expectedCliVersion) {
		throw "Installed Fikeya CLI did not report $PythonVersion for public release $PublicVersion."
	}
	& $fikeya --help | Out-Null
	if ($LASTEXITCODE -ne 0) {
		throw "Installed Fikeya CLI help command failed."
	}

	$receiptText = @(& $python (Join-Path $PSScriptRoot "test_installed_coding.py") --fikeya $fikeya) -join "`n"
	if ($LASTEXITCODE -ne 0) {
		throw "Installed Fikeya coding smoke test failed."
	}
	$receipt = $receiptText | ConvertFrom-Json
	if ($receipt.sessionStatus -cne "completed" -or $receipt.providerRequests -ne 7) {
		throw "Installed Fikeya coding smoke receipt is incomplete."
	}

	[ordered]@{
		ok = $true
		publicVersion = $PublicVersion
		pythonVersion = $PythonVersion
		providerRequests = $receipt.providerRequests
		approvals = @($receipt.approvals)
		changedFile = $receipt.changedFile
		sessionStatus = $receipt.sessionStatus
	} | ConvertTo-Json -Compress | Write-Output
} finally {
	if (Test-Path -LiteralPath $smokeRoot) {
		Remove-Item -LiteralPath $smokeRoot -Recurse -Force
	}
}
