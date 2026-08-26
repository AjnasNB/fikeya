[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string]$InstallerPath,
	[Parameter(Mandatory = $true)]
	[string]$PublicVersion,
	[Parameter(Mandatory = $true)]
	[string]$NumericVersion,
	[string]$InstallDirectory = ""
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
		"/MERGETASKS=`"!runcode`"",
		"/DIR=`"$installRoot`""
	)
	$installProcess = Start-Process -FilePath $installer -ArgumentList $installArguments -Wait -PassThru -WindowStyle Hidden
	if ($installProcess.ExitCode -ne 0) {
		throw "Installer exited with code $($installProcess.ExitCode)."
	}

	$executable = Join-Path $installRoot "Fikeya.exe"
	$launcher = Join-Path $installRoot "bin\fikeya.cmd"
	foreach ($requiredPath in @($executable, $launcher)) {
		if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
			throw "Installed Fikeya file is missing: $requiredPath"
		}
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
}
