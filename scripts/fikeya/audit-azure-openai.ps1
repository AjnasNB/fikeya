[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$ResourceGroup,
	[Parameter(Mandatory = $true)][string]$AccountName
)

$ErrorActionPreference = 'Stop'
$accountJson = az cognitiveservices account show `
	--resource-group $ResourceGroup `
	--name $AccountName `
	--output json
if ($LASTEXITCODE -ne 0) {
	throw 'Unable to read the Azure OpenAI account.'
}
$account = $accountJson | ConvertFrom-Json
$findings = @(
	[pscustomobject]@{
		Control = 'Public network disabled'
		Passed = $account.properties.publicNetworkAccess -eq 'Disabled'
		Actual = [string]$account.properties.publicNetworkAccess
	},
	[pscustomobject]@{
		Control = 'Local keys disabled'
		Passed = $account.properties.disableLocalAuth -eq $true
		Actual = [string]$account.properties.disableLocalAuth
	},
	[pscustomobject]@{
		Control = 'Default network action denied'
		Passed = $account.properties.networkAcls.defaultAction -eq 'Deny'
		Actual = [string]$account.properties.networkAcls.defaultAction
	}
)
$privateEndpoints = az network private-endpoint-connection list `
	--id $account.id `
	--query "[?properties.privateLinkServiceConnectionState.status=='Approved'] | length(@)" `
	--output tsv
if ($LASTEXITCODE -ne 0) {
	throw 'Unable to inspect Azure private endpoint connections.'
}
$findings += [pscustomobject]@{
	Control = 'Approved private endpoint present'
	Passed = [int]$privateEndpoints -gt 0
	Actual = [string]$privateEndpoints
}
$findings | Format-Table -AutoSize
if ($findings.Passed -contains $false) {
	exit 1
}
