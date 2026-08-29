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
$interopMetadata = Get-Content -LiteralPath (Join-Path $repositoryRoot "integrations\fikeya-interop\pyproject.toml") -Raw
$interopVersionMatch = [regex]::Match($interopMetadata, '(?m)^version = "([^"]+)"\r?$')
if (-not $interopVersionMatch.Success) {
	throw "Unable to read the Fikeya interop package version."
}
$interopVersion = [string]$interopVersionMatch.Groups[1].Value
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

$containmentCursor = $outputPath
while ($containmentCursor.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
	if (Test-Path -LiteralPath $containmentCursor) {
		$item = Get-Item -LiteralPath $containmentCursor -Force
		if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
			throw "Release output path cannot traverse a reparse point: $containmentCursor"
		}
	}
	$parent = [System.IO.Path]::GetDirectoryName($containmentCursor)
	if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $containmentCursor) { break }
	$containmentCursor = $parent
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

Invoke-Checked $repositoryRoot "node" @("scripts\fikeya\verify-version-alignment.ts")
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

$managedSidecarRoot = Join-Path $repositoryRoot "integrations\qarinah-sidecar"
Invoke-Checked $managedSidecarRoot "npm" @("ci", "--ignore-scripts", "--omit=dev")
Invoke-Checked $repositoryRoot "python" @(
	"scripts\fikeya\package_qarinah_sidecar.py",
	"--source",
	$managedSidecarRoot,
	"--output-directory",
	$outputPath,
	"--release-version",
	$releaseVersion
)
$managedSidecarBundleName = "fikeya-qarinah-sidecar-$releaseVersion.zip"
$managedSidecarBundlePath = Join-Path $outputPath $managedSidecarBundleName
if (-not (Test-Path -LiteralPath $managedSidecarBundlePath -PathType Leaf)) {
	throw "Managed Qarinah sidecar bundle was not produced."
}

$extensionRoot = Join-Path $repositoryRoot "extensions\fikeya-desktop"
Invoke-Checked $extensionRoot "npm" @("ci")
Invoke-Checked $extensionRoot "npm" @("run", "package:vsix")
Copy-Item -LiteralPath (Join-Path $extensionRoot "artifacts\fikeya-desktop-$extensionVersion-win32-x64.vsix") -Destination $outputPath
$desktopRuntimeReceiptPath = Join-Path $extensionRoot "runtime\fikeya-runtime.json"
if (-not (Test-Path -LiteralPath $desktopRuntimeReceiptPath -PathType Leaf)) {
	throw "Windows Desktop runtime receipt was not produced."
}
$desktopRuntimeReceipt = Get-Content -LiteralPath $desktopRuntimeReceiptPath -Raw | ConvertFrom-Json
$desktopBrowser = $desktopRuntimeReceipt.browser
if ($desktopRuntimeReceipt.target -cne "win32-x64" `
	-or $desktopBrowser.schemaVersion -cne "fikeya.desktop-browser-payload.v1" `
	-or $desktopBrowser.playwrightVersion -cne "1.62.0" `
	-or $desktopBrowser.browserVersion -cne "151.0.7922.34" `
	-or $desktopBrowser.revision -cne "1234" `
	-or $desktopBrowser.payloadSha256 -cne "sha256:a3ef07d44788de282bfddfd28350b230e9a795a441be39cce585fbca363338dc" `
	-or $desktopBrowser.payloadBytes -ne 287667597 `
	-or $desktopBrowser.fileCount -ne 299) {
	throw "Windows Desktop browser payload is missing or does not match the reviewed release."
}
$desktopRuntimeExecutable = Join-Path $extensionRoot ([string]$desktopRuntimeReceipt.executable)
if (-not (Test-Path -LiteralPath $desktopRuntimeExecutable -PathType Leaf)) {
	throw "Windows Desktop runtime executable containing the browser payload is missing."
}
$requiredBrowserPackages = @("playwright", "greenlet", "pyee", "typing-extensions", "chromium-headless-shell", "playwright-ffmpeg", "playwright-winldd")
foreach ($packageName in $requiredBrowserPackages) {
	$package = @($desktopRuntimeReceipt.packages | Where-Object name -eq $packageName)
	if ($package.Count -ne 1) {
		throw "Windows Desktop runtime license manifest is missing $packageName."
	}
	foreach ($licensePath in @($package[0].licenseFiles)) {
		$absoluteLicense = Join-Path $extensionRoot ([string]$licensePath)
		if (-not (Test-Path -LiteralPath $absoluteLicense -PathType Leaf)) {
			throw "Windows Desktop runtime license file is missing: $licensePath"
		}
	}
}

$cliInstall = @"
Fikeya CLI $releaseVersion

1. Extract this archive.
2. Create and activate a Python 3.10+ virtual environment.
3. Run the included installer from the extracted directory:

   powershell -ExecutionPolicy Bypass -File .\install-fikeya-cli.ps1

4. Verify the installation:

   fikeya --version
   fikeya --help
   fikeya init .
   fikeya doctor .

The installer resolves the local wheels to absolute file URIs, installs the
Runtime with Azure identity and Playwright support, and provisions the exact
Chromium Headless Shell selected by pinned Playwright 1.62.0. Internet access is
required for Python dependencies and the browser payload. The included
$managedSidecarBundleName contains the locked managed-memory sidecar; extract it
and register its binding receipt with the endpoint operator together with an
exact Node 22, 24, or 26 executable.
"@
$cliInstallPath = Join-Path $outputPath "FIKEYA-CLI-INSTALL.txt"
$cliInstall | Set-Content -LiteralPath $cliInstallPath -Encoding utf8
$cliInstallerPath = Join-Path $outputPath "install-fikeya-cli.ps1"
@'
[CmdletBinding()]
param([string]$PythonCommand = "python")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
function Get-OneWheel([string]$Prefix) {
	$matches = @(Get-ChildItem -LiteralPath $bundleRoot -File -Filter "$Prefix*.whl")
	if ($matches.Count -ne 1) {
		throw "Expected exactly one $Prefix wheel beside this installer; found $($matches.Count)."
	}
	$matches[0]
}

$agentCore = Get-OneWheel "fikeya_agent_core-"
$runtime = Get-OneWheel "fikeya_runtime-"
$interop = Get-OneWheel "fikeya_interop-"
$runtimeRequirement = "fikeya-runtime[azure,browser] @ $(([Uri]$runtime.FullName).AbsoluteUri)"

& $PythonCommand -m pip install --disable-pip-version-check $agentCore.FullName $runtimeRequirement $interop.FullName
if ($LASTEXITCODE -ne 0) { throw "Fikeya CLI installation failed." }
& $PythonCommand -m playwright install chromium-headless-shell
if ($LASTEXITCODE -ne 0) { throw "Fikeya CLI browser provisioning failed." }
& $PythonCommand -c "import azure.identity; import fikeya_runtime; import playwright; print(fikeya_runtime.__version__)"
if ($LASTEXITCODE -ne 0) { throw "Fikeya CLI Azure and browser support verification failed." }
'@ | Set-Content -LiteralPath $cliInstallerPath -Encoding utf8
$cliBundle = Join-Path $outputPath "fikeya-cli-$releaseVersion.zip"
$cliFiles = Get-ChildItem -LiteralPath $outputPath -File | Where-Object {
	$_.Extension -eq ".whl" -or $_.Name -in @("FIKEYA-CLI-INSTALL.txt", "install-fikeya-cli.ps1", $managedSidecarBundleName)
}
Compress-Archive -LiteralPath $cliFiles.FullName -DestinationPath $cliBundle -CompressionLevel Optimal
& (Join-Path $PSScriptRoot "verify-cli-bundle.ps1") `
	-BundlePath $cliBundle `
	-PublicVersion $releaseVersion `
	-PythonVersion $runtimeVersion

if (-not $SkipDesktop) {
	Invoke-Checked $repositoryRoot "npm" @("run", "gulp", "--", "compile-build-without-mangling")
	Invoke-Checked $repositoryRoot "npm" @("run", "gulp", "--", "vscode-win32-x64")
	$packagedExtensionRoot = Join-Path (Split-Path -Parent $repositoryRoot) "VSCode-win32-x64\resources\app\extensions\fikeya-desktop"
	$packagedSidecarRoot = Join-Path $packagedExtensionRoot "sidecar"
	$stagedSidecarRoot = Join-Path $extensionRoot ".package\extension\sidecar"
	$stagedSidecar = Join-Path $stagedSidecarRoot "qarinah-memory-view.mjs"
	$stagedSidecarReceipt = Join-Path $stagedSidecarRoot "qarinah-runtime.json"
	foreach ($requiredSidecarPath in @($stagedSidecar, $stagedSidecarReceipt)) {
		if (-not (Test-Path -LiteralPath $requiredSidecarPath -PathType Leaf)) {
			throw "Bundled Qarinah Desktop sidecar is missing: $requiredSidecarPath"
		}
	}
	New-Item -ItemType Directory -Path $packagedSidecarRoot -Force | Out-Null
	Copy-Item -LiteralPath $stagedSidecar -Destination (Join-Path $packagedSidecarRoot "qarinah-memory-view.mjs") -Force
	Copy-Item -LiteralPath $stagedSidecarReceipt -Destination (Join-Path $packagedSidecarRoot "qarinah-runtime.json") -Force
	$packagedProduct = Join-Path (Split-Path -Parent $repositoryRoot) "VSCode-win32-x64\resources\app\product.json"
	$packagedPackage = Join-Path (Split-Path -Parent $repositoryRoot) "VSCode-win32-x64\resources\app\package.json"
	$packagedExecutable = Join-Path (Split-Path -Parent $repositoryRoot) "VSCode-win32-x64\Fikeya.exe"
	$runtimeCompatibilityVersion = [string](Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json).version
	Invoke-Checked $repositoryRoot "python" @(
		"scripts\fikeya\verify_packaged_product.py",
		$packagedProduct,
		"--package-json",
		$packagedPackage,
		"--runtime-version",
		$runtimeCompatibilityVersion,
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
		-NumericVersion ([string]$distribution.desktopNumericVersion) `
		-PythonCommand "python"

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
