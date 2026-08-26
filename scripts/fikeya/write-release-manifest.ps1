[CmdletBinding()]
param(
	[string]$OutputDirectory = "",
	[string]$Version = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
	$Version = [string]((Get-Content -LiteralPath (Join-Path $repositoryRoot "fikeya-distribution.json") -Raw | ConvertFrom-Json).version)
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
	$OutputDirectory = Join-Path $repositoryRoot "release-artifacts"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$rootPrefix = $repositoryRoot.TrimEnd('\') + '\'
if (-not $outputPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
	throw "Release output must remain inside the repository: $outputPath"
}
if (-not (Test-Path -LiteralPath $outputPath -PathType Container)) {
	throw "Release output does not exist: $outputPath"
}

$artifacts = @(Get-ChildItem -LiteralPath $outputPath -File |
	Where-Object { $_.Name -notin @("release-verification.json", "SHA256SUMS.txt") } |
	Sort-Object Name)
if ($artifacts.Count -eq 0) {
	throw "No release artifacts were found in $outputPath"
}

$verification = foreach ($artifact in $artifacts) {
	$signature = if ($artifact.Extension -eq ".exe") { Get-AuthenticodeSignature -LiteralPath $artifact.FullName } else { $null }
	[ordered]@{
		name = $artifact.Name
		bytes = $artifact.Length
		sha256 = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
		authenticodeStatus = if ($signature) { [string]$signature.Status } else { "not-applicable" }
		signer = if ($signature -and $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
	}
}

$manifest = [ordered]@{
	schemaVersion = 1
	product = "Fikeya"
	version = $Version
	commit = (git -C $repositoryRoot rev-parse HEAD).Trim()
	generatedAt = (Get-Date).ToUniversalTime().ToString("o")
	artifacts = @($verification)
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputPath "release-verification.json") -Encoding utf8

$hashLines = Get-ChildItem -LiteralPath $outputPath -File |
	Where-Object Name -ne "SHA256SUMS.txt" |
	Sort-Object Name |
	ForEach-Object { "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name }
$hashLines | Set-Content -LiteralPath (Join-Path $outputPath "SHA256SUMS.txt") -Encoding ascii

Write-Host "Verified $($artifacts.Count) release artifacts in $outputPath"
