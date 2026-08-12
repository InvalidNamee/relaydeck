$ErrorActionPreference = 'Stop'

$ruleName = 'Relaydeck Gateway (Private LAN)'
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($null -eq $existingRule) {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 8788 `
    -Profile Private `
    -RemoteAddress LocalSubnet | Out-Null
}

Write-Host "Relaydeck firewall rule is ready for private local networks."
