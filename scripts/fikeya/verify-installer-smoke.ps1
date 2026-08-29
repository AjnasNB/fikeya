[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string]$InstallerPath,
	[Parameter(Mandatory = $true)]
	[string]$PublicVersion,
	[Parameter(Mandatory = $true)]
	[string]$NumericVersion,
	[string]$InstallDirectory = "",
	[string]$PythonCommand = "python"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot ".build"))
if ([string]::IsNullOrWhiteSpace($InstallDirectory)) {
	$InstallDirectory = Join-Path $buildRoot "installer-smoke-$([guid]::NewGuid().ToString('N'))"
}
$installRoot = [System.IO.Path]::GetFullPath($InstallDirectory)
$installLog = "$installRoot-install.log"
$buildPrefix = $buildRoot.TrimEnd('\') + '\'
if (-not $installRoot.StartsWith($buildPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
	throw "Installer smoke directory must remain inside $buildRoot"
}
if ($installRoot -eq $buildRoot) {
	throw "Installer smoke directory cannot be the build root."
}
if (Test-Path -LiteralPath $installRoot) {
	throw "Installer smoke directory already exists: $installRoot"
}

New-Item -ItemType Directory -Path $installRoot | Out-Null
try {
	$installArguments = @(
		"/VERYSILENT",
		"/SUPPRESSMSGBOXES",
		"/NORESTART",
		"/SP-",
		"/NOCLOSEAPPLICATIONS",
		"/LOG=`"$installLog`"",
		"/MERGETASKS=`"!runcode`"",
		"/DIR=`"$installRoot`""
	)
	$installProcess = Start-Process -FilePath $installer -ArgumentList $installArguments -Wait -PassThru -WindowStyle Hidden
	if ($installProcess.ExitCode -ne 0) {
		$logTail = if (Test-Path -LiteralPath $installLog -PathType Leaf) {
			(@(Get-Content -LiteralPath $installLog -Tail 24) -join "`n")
		} else {
			"Installer log was not created."
		}
		throw "Installer exited with code $($installProcess.ExitCode).`n$logTail"
	}

	$executable = Join-Path $installRoot "Fikeya.exe"
	$launcher = Join-Path $installRoot "bin\fikeya.cmd"
	foreach ($requiredPath in @($executable, $launcher)) {
		if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
			throw "Installed Fikeya file is missing: $requiredPath"
		}
	}
	$installedExtensionRoot = Join-Path $installRoot "resources\app\extensions\fikeya-desktop"
	$qarinahSidecar = Join-Path $installedExtensionRoot "sidecar\qarinah-memory-view.mjs"
	$qarinahSidecarReceipt = Join-Path $installedExtensionRoot "sidecar\qarinah-runtime.json"
	foreach ($requiredPath in @($qarinahSidecar, $qarinahSidecarReceipt)) {
		if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
			throw "Installed Fikeya Qarinah sidecar file is missing: $requiredPath"
		}
	}
	$qarinahReceipt = Get-Content -LiteralPath $qarinahSidecarReceipt -Raw | ConvertFrom-Json
	$qarinahBundleHash = "sha256:$((Get-FileHash -LiteralPath $qarinahSidecar -Algorithm SHA256).Hash.ToLowerInvariant())"
	if ($qarinahReceipt.schemaVersion -cne "fikeya.desktop-bundled-runtime.v1" `
		-or $qarinahReceipt.entrypoint -cne "sidecar/qarinah-memory-view.mjs" `
		-or $qarinahReceipt.bundleSha256 -cne $qarinahBundleHash) {
		throw "Installed Fikeya Qarinah sidecar receipt does not match its bundle."
	}
	$qarinahSmokeRoot = Join-Path $installRoot "qarinah-smoke"
	New-Item -ItemType Directory -Path $qarinahSmokeRoot | Out-Null
	$qarinahProcessInfo = [System.Diagnostics.ProcessStartInfo]::new()
	$qarinahProcessInfo.FileName = $executable
	$qarinahProcessInfo.ArgumentList.Add($qarinahSidecar)
	$qarinahProcessInfo.ArgumentList.Add("--root")
	$qarinahProcessInfo.ArgumentList.Add($qarinahSmokeRoot)
	$qarinahProcessInfo.WorkingDirectory = $qarinahSmokeRoot
	$qarinahProcessInfo.UseShellExecute = $false
	$qarinahProcessInfo.CreateNoWindow = $true
	$qarinahProcessInfo.RedirectStandardInput = $true
	$qarinahProcessInfo.RedirectStandardOutput = $true
	$qarinahProcessInfo.RedirectStandardError = $true
	$qarinahProcessInfo.Environment["ELECTRON_RUN_AS_NODE"] = "1"
	$qarinahProcess = [System.Diagnostics.Process]::Start($qarinahProcessInfo)
	$qarinahRequest = @{
		jsonrpc = "2.0"
		id = "fikeya-memory-init"
		method = "memory.initialize"
		params = @{}
	} | ConvertTo-Json -Compress
	$qarinahProcess.StandardInput.WriteLine($qarinahRequest)
	$qarinahProcess.StandardInput.Close()
	$qarinahOutput = $qarinahProcess.StandardOutput.ReadToEnd()
	$qarinahError = $qarinahProcess.StandardError.ReadToEnd()
	if (-not $qarinahProcess.WaitForExit(30000)) {
		$qarinahProcess.Kill($true)
		throw "Installed Fikeya Qarinah sidecar timed out."
	}
	if ($qarinahProcess.ExitCode -ne 0) {
		throw "Installed Fikeya Qarinah sidecar exited with code $($qarinahProcess.ExitCode): $($qarinahError.Substring(0, [Math]::Min(1000, $qarinahError.Length)))"
	}
	$qarinahResponseLine = @($qarinahOutput -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) | Select-Object -First 1
	$qarinahResponse = $qarinahResponseLine | ConvertFrom-Json
	if ($qarinahResponse.jsonrpc -cne "2.0" `
		-or $qarinahResponse.id -cne "fikeya-memory-init" `
		-or $qarinahResponse.result.schemaVersion -cne "qarinah.workspace-initialization.v1" `
		-or $qarinahResponse.result.workspaceId -notmatch '^ws_[0-9a-f]{32}$' `
		-or -not (Test-Path -LiteralPath (Join-Path $qarinahSmokeRoot ".qarinah") -PathType Container)) {
		throw "Installed Fikeya Qarinah sidecar did not initialize a verified workspace."
	}
	$bundledRuntimeRoot = Join-Path $installRoot "resources\app\extensions\fikeya-desktop\runtime"
	$bundledRuntime = Join-Path $bundledRuntimeRoot "fikeya-runtime.exe"
	$bundledRuntimeReceipt = Join-Path $bundledRuntimeRoot "fikeya-runtime.json"
	foreach ($requiredPath in @($bundledRuntime, $bundledRuntimeReceipt)) {
		if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
			throw "Installed Fikeya browser runtime file is missing: $requiredPath"
		}
	}
	$browserSmokeRoot = Join-Path $installRoot "browser-smoke"
	New-Item -ItemType Directory -Path $browserSmokeRoot | Out-Null
	$browserSmokeOutput = @(& $PythonCommand `
		(Join-Path $PSScriptRoot "test_installed_browser.py") `
		--runtime-executable $bundledRuntime `
		--runtime-receipt $bundledRuntimeReceipt `
		--workspace $browserSmokeRoot `
		--allow-private-fixture) -join "`n"
	if ($LASTEXITCODE -ne 0) {
		throw "Installed Fikeya browser smoke failed."
	}
	$browserSmoke = $browserSmokeOutput | ConvertFrom-Json
	if ($browserSmoke.schemaVersion -cne "fikeya.installed-browser-smoke.v1" `
		-or $browserSmoke.planStatus -cne "succeeded" `
		-or $browserSmoke.privateHostConsent -cne "explicit" `
		-or $browserSmoke.remoteNetworkAllowed -ne $false) {
		throw "Installed Fikeya browser smoke receipt is incomplete."
	}

	$version = (Get-Item -LiteralPath $executable).VersionInfo
	$expected = [ordered]@{
		ProductName = "Fikeya"
		CompanyName = "Ajnas N B"
		FileDescription = "Fikeya"
		OriginalFilename = "Fikeya.exe"
		FileVersion = $NumericVersion
		ProductVersion = $PublicVersion
		FileVersionRaw = $NumericVersion
		ProductVersionRaw = $NumericVersion
	}
	foreach ($entry in $expected.GetEnumerator()) {
		$actual = if ($entry.Key -eq "FileVersionRaw" -or $entry.Key -eq "ProductVersionRaw") {
			$version.($entry.Key).ToString()
		} else {
			[string]$version.($entry.Key)
		}
		if ($actual -cne [string]$entry.Value) {
			throw "Installed Fikeya $($entry.Key) is '$actual'; expected '$($entry.Value)'."
		}
	}

	$signature = Get-AuthenticodeSignature -LiteralPath $executable
	if ($signature.Status -ne "NotSigned" -and $signature.Status -ne "Valid") {
		throw "Installed Fikeya executable signature status is $($signature.Status)."
	}

	Add-Type -AssemblyName System.Drawing
	$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($executable)
	if ($null -eq $icon -or $icon.Width -lt 16 -or $icon.Height -lt 16) {
		throw "Installed Fikeya executable does not expose a usable application icon."
	}
	$icon.Dispose()

	$launcherVersions = [ordered]@{}
	foreach ($versionArgument in @("--version", "-v")) {
		$launcherOutput = @(& $launcher $versionArgument)
		if ($LASTEXITCODE -ne 0) {
			throw "Installed Fikeya launcher $versionArgument exited with code $LASTEXITCODE."
		}
		if ($launcherOutput.Count -lt 1 -or $launcherOutput[0].Trim() -cne $PublicVersion) {
			throw "Installed Fikeya launcher $versionArgument did not report $PublicVersion."
		}
		$launcherVersions[$versionArgument] = $launcherOutput[0].Trim()
	}

	[ordered]@{
		ok = $true
		product = $version.ProductName
		publicVersion = $version.ProductVersion
		numericVersion = $version.FileVersionRaw.ToString()
		publisher = $version.CompanyName
		authenticodeStatus = [string]$signature.Status
		launcherVersion = $launcherVersions["--version"]
		launcherVersionAlias = $launcherVersions["-v"]
		browserVersion = $browserSmoke.browserVersion
		browserPayloadSha256 = $browserSmoke.payloadSha256
		browserLicenseFiles = $browserSmoke.licenseFiles
	} | ConvertTo-Json -Compress | Write-Output
} finally {
	$uninstaller = Join-Path $installRoot "unins000.exe"
	if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
		$uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @(
			"/VERYSILENT",
			"/SUPPRESSMSGBOXES",
			"/NORESTART"
		) -Wait -PassThru -WindowStyle Hidden
		if ($uninstallProcess.ExitCode -ne 0) {
			Write-Warning "Fikeya smoke uninstaller exited with code $($uninstallProcess.ExitCode)."
		}
	}
	if (Test-Path -LiteralPath $installRoot) {
		Remove-Item -LiteralPath $installRoot -Recurse -Force
	}
	if (Test-Path -LiteralPath $installLog -PathType Leaf) {
		Remove-Item -LiteralPath $installLog -Force
	}
}
