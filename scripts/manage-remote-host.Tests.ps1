$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'manage-remote-host.ps1'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('remote host test ' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
    $binary = Join-Path $fixtureRoot 'terminal-v4-api.exe'
    Set-Content -LiteralPath $binary -Value 'fixture'
    $config = Join-Path $fixtureRoot 'host config'
    $data = Join-Path $fixtureRoot 'data folder'
    $plan = & $scriptPath -Action Plan -ApiBinary $binary -ConfigDirectory $config -DataDirectory $data | ConvertFrom-Json
    if ($plan.apiBinary -ne [IO.Path]::GetFullPath($binary)) { throw 'Binary path was changed.' }
    if ($plan.bindAddress -ne '127.0.0.1' -or $plan.port -ne 3020) { throw 'Default bind must remain loopback.' }
    if ($plan.runtimeRoot -ne (Split-Path -Parent $PSScriptRoot)) { throw 'Runtime root must preserve repository SDK helper paths.' }
    if ($plan.startupScope -ne 'current-user-logon') { throw 'Startup scope is misleading.' }
    if (Test-Path -LiteralPath $config) { throw 'Plan wrote configuration.' }
    $rejected = $false
    try { & $scriptPath -Action Plan -ApiBinary $binary -ConfigDirectory $config -DataDirectory $data -BindAddress '0.0.0.0' } catch { $rejected=$true }
    if (-not $rejected) { throw 'LAN bind accepted without explicit consent.' }
    $rejected = $false
    try { & $scriptPath -Action Plan -ApiBinary $binary -ConfigDirectory $config -DataDirectory $data -BindAddress 'bad;host' -AllowLan } catch { $rejected=$true }
    if (-not $rejected) { throw 'Invalid bind accepted.' }
    $lan = & $scriptPath -Action Plan -ApiBinary $binary -ConfigDirectory $config -DataDirectory $data -BindAddress '0.0.0.0' -AllowLan | ConvertFrom-Json
    if ($lan.bindAddress -ne '0.0.0.0') { throw 'Explicit LAN bind ignored.' }
    & $scriptPath -Action Initialize -ApiBinary $binary -ConfigDirectory $config -DataDirectory $data | Out-Null
    $publicConfig = Get-Content -LiteralPath (Join-Path $config 'host.json') -Raw | ConvertFrom-Json
    $allContent = (Get-Content -LiteralPath (Join-Path $config 'host.json') -Raw)
    if ($allContent -match 'JWT_SECRET|REFRESH_SECRET') { throw 'Public config contains secrets.' }
    if (-not (Test-Path -LiteralPath (Join-Path $config 'secrets.dpapi'))) { throw 'Protected credentials missing.' }
    $status = & $scriptPath -Action Status -ConfigDirectory $config | ConvertFrom-Json
    if ($status.running -or $status.startupInstalled) { throw 'Initialize unexpectedly started or installed a task.' }
    $rejected = $false
    try { & $scriptPath -Action Initialize -ApiBinary $binary -ConfigDirectory $config -DataDirectory $data } catch { $rejected=$true }
    if (-not $rejected) { throw 'Existing host config was overwritten.' }
    & $scriptPath -Action Install -ConfigDirectory $config -WhatIf | Out-Null
    $status = & $scriptPath -Action Status -ConfigDirectory $config | ConvertFrom-Json
    if ($status.startupInstalled) { throw 'WhatIf installed a startup task.' }
    & $scriptPath -Action Run -ConfigDirectory $config -WhatIf | Out-Null
    if (Test-Path -LiteralPath (Join-Path $config 'runtime.json')) { throw 'Run WhatIf started the API.' }
    if ($env:TERMINAL_V4_HOST_SMOKE -eq '1') {
        $source = Join-Path $fixtureRoot 'host_fixture.rs'
        Set-Content -LiteralPath $source -Value 'fn main() { loop { std::thread::sleep(std::time::Duration::from_secs(1)); } }'
        & rustc $source -o $binary
        if ($LASTEXITCODE -ne 0) { throw 'Harmless host fixture failed to compile.' }
        try {
            & $scriptPath -Action Start -ConfigDirectory $config | Out-Null
            $deadline = [DateTime]::UtcNow.AddSeconds(12)
            do {
                Start-Sleep -Milliseconds 250
                $status = & $scriptPath -Action Status -ConfigDirectory $config | ConvertFrom-Json
            } until ($status.running -or [DateTime]::UtcNow -ge $deadline)
            if (-not $status.running) { throw 'Harmless hidden host did not start.' }
            & $scriptPath -Action Stop -ConfigDirectory $config | Out-Null
            Start-Sleep -Milliseconds 250
            $status = & $scriptPath -Action Status -ConfigDirectory $config | ConvertFrom-Json
            if ($status.running) { throw 'Verified host process did not stop.' }
            Write-Output 'Harmless background process start/status/stop smoke passed.'
        } finally { & $scriptPath -Action Stop -ConfigDirectory $config | Out-Null }
    }
    Write-Output 'Remote host plan, encrypted configuration, validation, and WhatIf checks passed.' 
} finally {
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Temporary cleanup path escaped.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
