[CmdletBinding()]
param(
	[string]$OutputDirectory = "",
	[switch]$SkipDesktop,
	[switch]$SkipManifest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$distribution = Get-Content -LiteralPath (Join-Path $repositoryRoot "fikeya-distribution.json") -Raw | ConvertFrom-Json
$releaseVersion = [string]$distribution.version
$componentManifest = Get-Content -LiteralPath (Join-Path $repositoryRoot "scripts\fikeya\components.json") -Raw | ConvertFrom-Json
$agentCoreVersion = [string](($componentManifest.components | Where-Object id -eq "agent-core").version)
$runtimeVersion = [string](($componentManifest.components | Where-Object id -eq "runtime").version)
$interopVersion = [string]((Get-Content -LiteralPath (Join-Path $repositoryRoot "integrations\fikeya-interop\pyproject.toml") -Raw | Select-String -Pattern '(?m)^version = "([^"]+)"$').Matches[0].Groups[1].Value)
$extensionManifest = Get-Content -LiteralPath (Join-Path $repositoryRoot "extensions\fikeya-desktop\package.json") -Raw | ConvertFrom-Json
$extensionVersion = [string]$extensionManifest.version
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
	$OutputDirectory = Join-Path $repositoryRoot "release-artifacts"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$rootPrefix = $repositoryRoot.TrimEnd('\') + '\'
if (-not $outputPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
	throw "Release output must remain inside the repository: $outputPath"
}
if ($outputPath -eq $repositoryRoot) {
	throw "Release output cannot be the repository root."
}

if (Test-Path -LiteralPath $outputPath) {
	Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath | Out-Null

function Invoke-Checked {
	param([string]$WorkingDirectory, [string]$FilePath, [string[]]$Arguments)
	Push-Location $WorkingDirectory
	try {
		& $FilePath @Arguments
		if ($LASTEXITCODE -ne 0) {
			throw "$FilePath failed with exit code $LASTEXITCODE in $WorkingDirectory"
		}
	} finally {
		Pop-Location
	}
}

Invoke-Checked $repositoryRoot "python" @("-m", "pip", "install", "--disable-pip-version-check", "build==1.5.0")
$runtimeBuildRequirements = Join-Path $repositoryRoot "extensions\fikeya-desktop\runtime-build-requirements.txt"
Invoke-Checked $repositoryRoot "python" @(
	"-m",
	"pip",
	"install",
	"--disable-pip-version-check",
	"--requirement",
	$runtimeBuildRequirements
)
foreach ($component in @("fikeya-agent-core", "fikeya-runtime", "integrations\fikeya-interop")) {
	Invoke-Checked (Join-Path $repositoryRoot $component) "python" @("-m", "build", "--outdir", $outputPath)
}

$extensionRoot = Join-Path $repositoryRoot "extensions\fikeya-desktop"
Invoke-Checked $extensionRoot "npm" @("ci")
Invoke-Checked $extensionRoot "npm" @("run", "package:vsix")
Copy-Item -LiteralPath (Join-Path $extensionRoot "artifacts\fikeya-desktop-$extensionVersion-win32-x64.vsix") -Destination $outputPath

$cliInstall = @"
Fikeya CLI $releaseVersion

1. Extract this archive.
2. Create and activate a Python 3.10+ virtual environment.
3. Install the Agent Core wheel, then the Runtime wheel:

   python -m pip install fikeya_agent_core-$agentCoreVersion-py3-none-any.whl
   python -m pip install "fikeya-runtime[azure] @ file:./fikeya_runtime-$runtimeVersion-py3-none-any.whl"
   python -m pip install fikeya_interop-$interopVersion-py3-none-any.whl

4. Verify the installation:

   fikeya --help
   fikeya init .
   fikeya doctor .
"@
$cliInstallPath = Join-Path $outputPath "FIKEYA-CLI-INSTALL.txt"
$cliInstall | Set-Content -LiteralPath $cliInstallPath -Encoding utf8
$cliBundle = Join-Path $outputPath "fikeya-cli-$releaseVersion.zip"
$cliFiles = Get-ChildItem -LiteralPath $outputPath -File | Where-Object { $_.Extension -eq ".whl" -or $_.Name -eq "FIKEYA-CLI-INSTALL.txt" }
Compress-Archive -LiteralPath $cliFiles.FullName -DestinationPath $cliBundle -CompressionLevel Optimal
& (Join-Path $PSScriptRoot "verify-cli-bundle.ps1") `
	-BundlePath $cliBundle `
	-PublicVersion $releaseVersion `
	-PythonVersion $runtimeVersion

if (-not $SkipDesktop) {
	Invoke-Checked $repositoryRoot "npm" @("run", "gulp", "--", "compile-build-without-mangling")
	Invoke-Checked $repositoryRoot "npm" @("run", "gulp", "--", "vscode-win32-x64")
	$packagedProduct = Join-Path (Split-Path -Parent $repositoryRoot) "VSCode-win32-x64\resources\app\product.json"
	$packagedExecutable = Join-Path (Split-Path -Parent $repositoryRoot) "VSCode-win32-x64\Fikeya.exe"
	Invoke-Checked $repositoryRoot "python" @(
		"scripts\fikeya\verify_packaged_product.py",
		$packagedProduct,
		"--executable",
		$packagedExecutable,
		"--public-version",
		$releaseVersion,
		"--numeric-version",
		[string]$distribution.desktopNumericVersion
	)
	Invoke-Checked $repositoryRoot "npm" @("run", "gulp", "--", "vscode-win32-x64-user-setup")
	$setupSource = Join-Path $repositoryRoot ".build\win32-x64\user-setup\FikeyaSetup.exe"
	if (-not (Test-Path -LiteralPath $setupSource)) {
		throw "Windows installer was not produced at $setupSource"
	}
	$setupTarget = Join-Path $outputPath "FikeyaSetup-$releaseVersion-win32-x64.exe"
	Copy-Item -LiteralPath $setupSource -Destination $setupTarget
	& (Join-Path $PSScriptRoot "verify-installer-smoke.ps1") `
		-InstallerPath $setupTarget `
		-PublicVersion $releaseVersion `
		-NumericVersion ([string]$distribution.desktopNumericVersion)

	if ($env:FIKEYA_SIGNING_PFX_BASE64 -and $env:FIKEYA_SIGNING_PFX_PASSWORD) {
		$pfxPath = Join-Path $env:TEMP "fikeya-release-signing.pfx"
		try {
			[System.IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:FIKEYA_SIGNING_PFX_BASE64))
			& signtool sign /f $pfxPath /p $env:FIKEYA_SIGNING_PFX_PASSWORD /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $setupTarget
			if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }
		} finally {
			if (Test-Path -LiteralPath $pfxPath) { Remove-Item -LiteralPath $pfxPath -Force }
		}
	}
}

if (-not $SkipManifest) {
	& (Join-Path $PSScriptRoot "write-release-manifest.ps1") -OutputDirectory $outputPath -Version $releaseVersion
}

Write-Host "Fikeya release artifacts: $outputPath"
Get-ChildItem -LiteralPath $outputPath -File | Sort-Object Name | Format-Table Name, Length
