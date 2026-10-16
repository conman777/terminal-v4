[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('Plan','Initialize','Run','Start','Stop','Status','Install','Uninstall')][string]$Action = 'Status',
    [string]$ApiBinary,
    [string]$ConfigDirectory = (Join-Path $env:LOCALAPPDATA 'terminal-v4-host'),
    [string]$DataDirectory = $(if ($env:TERMINAL_DATA_DIR) { $env:TERMINAL_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'terminal-v4' }),
    [string]$BindAddress = '127.0.0.1',
    [string]$RuntimeRoot = (Split-Path -Parent $PSScriptRoot),
    [ValidateRange(1,65535)][int]$Port = 3020,
    [switch]$AllowLan
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Resolve-HostPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1f"]') { throw 'Paths must be nonempty and contain no control characters or double quotes.' }
    $full = [IO.Path]::GetFullPath($Value)
    $probe = $full
    while (-not [string]::IsNullOrWhiteSpace($probe)) {
        if (Test-Path -LiteralPath $probe) {
            if ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Host paths cannot contain symbolic links or junctions.' }
        }
        $parent = [IO.Path]::GetDirectoryName($probe)
        if ($parent -eq $probe) { break }
        $probe = $parent
    }
    return $full
}
function Protect-HostDirectory([string]$Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $propagate = [Security.AccessControl.PropagationFlags]::None
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl',$inherit,$propagate,'Allow')))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),'FullControl',$inherit,$propagate,'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function New-HostSecret {
    $bytes = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes); return [Convert]::ToBase64String($bytes) } finally { $rng.Dispose() }
}
$configRoot = Resolve-HostPath $ConfigDirectory
$configPath = Join-Path $configRoot 'host.json'
$secretsPath = Join-Path $configRoot 'secrets.dpapi'
$runtimePath = Join-Path $configRoot 'runtime.json'
$hostScript = Resolve-HostPath $PSCommandPath
$taskName = 'Terminal-v4-host-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$powerShell = (Get-Process -Id $PID).Path
function Read-HostConfiguration {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Host is not initialized. Run -Action Initialize first.' }
    $value = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($value.version -ne 1) { throw 'Unsupported host configuration version.' }
    $value.apiBinary = Resolve-HostPath $value.apiBinary
    $value.dataDirectory = Resolve-HostPath $value.dataDirectory
    $value.runtimeRoot = Resolve-HostPath $value.runtimeRoot
    if (-not (Test-Path -LiteralPath $value.runtimeRoot -PathType Container)) { throw 'RuntimeRoot directory is missing.' }
    if ([IO.Path]::GetFileName($value.apiBinary) -ne 'terminal-v4-api.exe' -or -not (Test-Path -LiteralPath $value.apiBinary -PathType Leaf)) { throw 'Configured Terminal v4 API executable is missing.' }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($value.bindAddress,[ref]$address) -or $value.port -lt 1 -or $value.port -gt 65535) { throw 'Invalid stored host address or port.' }
    return $value
}
function Get-HostProcess {
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { return $null }
    try {
        $record = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
        $process = Get-Process -Id $record.processId -ErrorAction Stop
        if ($process.Path -ne $record.apiBinary -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTicks) { return $null }
        return $process
    } catch { return $null }
}
if ($Action -in @('Plan','Initialize')) {
    $binaryPath = Resolve-HostPath $ApiBinary
    $dataPath = Resolve-HostPath $DataDirectory
    $rootPath = Resolve-HostPath $RuntimeRoot
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { throw 'RuntimeRoot directory is missing.' }
    if ([IO.Path]::GetFileName($binaryPath) -ne 'terminal-v4-api.exe' -or -not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) { throw 'ApiBinary must point to an existing terminal-v4-api.exe.' }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($BindAddress,[ref]$address)) { throw 'BindAddress must be an IP address.' }
    if (-not [Net.IPAddress]::IsLoopback($address) -and -not $AllowLan) { throw 'Non-loopback listening requires -AllowLan.' }
    $configuration = [ordered]@{ version=1; runtimeRoot=$rootPath; apiBinary=$binaryPath; dataDirectory=$dataPath; bindAddress=$address.ToString(); port=$Port; startupScope='current-user-logon' }
    if ($Action -eq 'Plan') { $configuration | ConvertTo-Json; return }
    if (Test-Path -LiteralPath $configPath) { throw 'Host is already initialized; existing configuration and pairing secrets were preserved.' }
    if ($PSCmdlet.ShouldProcess($configRoot,'Initialize protected Terminal v4 host configuration')) {
        Protect-HostDirectory $configRoot
        $environment = @{}
        foreach ($name in @('JWT_SECRET','REFRESH_SECRET','STORAGE_DATABASE_URL','ALLOWED_USERNAME','HERMES_EXECUTABLE','HERMES_PYTHON','HERMES_HOME','CLAUDE_CONFIG_DIR','CODEX_HOME','TERMINAL_V4_DESKTOP_ACCESS','TERMINAL_V4_RELAY_URL','TERMINAL_V4_RELAY_KEY','TERMINAL_V4_RELAY_SERVER_KEY','CLAUDE_BIN','OPENAI_API_KEY','ANTHROPIC_API_KEY','GROQ_API_KEY')) {
            $value = [Environment]::GetEnvironmentVariable($name,'Process')
            if (-not [string]::IsNullOrWhiteSpace($value)) { $environment[$name]=$value }
        }
        if (-not $environment.ContainsKey('JWT_SECRET')) { $environment.JWT_SECRET=New-HostSecret }
        if (-not $environment.ContainsKey('REFRESH_SECRET')) { $environment.REFRESH_SECRET=New-HostSecret }
        if ($environment.JWT_SECRET.Length -lt 32 -or $environment.JWT_SECRET -eq 'dev-secret-change-me') { throw 'JWT_SECRET must be at least 32 characters.' }
        $encrypted = ConvertFrom-SecureString (ConvertTo-SecureString ($environment | ConvertTo-Json -Compress) -AsPlainText -Force)
        [IO.File]::WriteAllText($secretsPath,$encrypted)
        [IO.File]::WriteAllText($configPath,($configuration | ConvertTo-Json))
        $configuration | ConvertTo-Json
    }
    return
}
$configuration = Read-HostConfiguration
if ($Action -eq 'Status') {
    $process = Get-HostProcess
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    [ordered]@{ running=($null -ne $process); startupInstalled=($null -ne $task); startupScope='current-user-logon'; bindAddress=$configuration.bindAddress; port=$configuration.port; dataDirectory=$configuration.dataDirectory; desktopMode='attach' } | ConvertTo-Json
    return
}
if ($Action -eq 'Install') {
    if ($PSCmdlet.ShouldProcess($taskName,'Register current-user logon host task')) {
        $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $hostScript + '" -Action Run -ConfigDirectory "' + $configRoot + '"'
        $taskAction = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory ([IO.Path]::GetDirectoryName($hostScript))
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    }
    return
}
if ($Action -eq 'Uninstall') {
    if ($PSCmdlet.ShouldProcess($taskName,'Remove logon task (running host remains available)')) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
    return
}
if ($Action -eq 'Stop') {
    $process = Get-HostProcess
    if ($null -ne $process -and $PSCmdlet.ShouldProcess($process.Id,'Stop only the verified Terminal v4 host process')) { Stop-Process -InputObject $process -ErrorAction Stop }
    return
}
if ($Action -eq 'Start') {
    if ($null -ne (Get-HostProcess)) { throw 'Configured host is already running.' }
    if ($PSCmdlet.ShouldProcess($configRoot,'Start hidden Terminal v4 host')) {
        $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $hostScript + '" -Action Run -ConfigDirectory "' + $configRoot + '"'
        Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    }
    return
}
if ($Action -eq 'Run') {
    if (-not $PSCmdlet.ShouldProcess($configRoot,'Run configured Terminal v4 host')) { return }
    $lock = $null
    try {
        $lock = [IO.File]::Open((Join-Path $configRoot 'host.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        if ($null -ne (Get-HostProcess)) { throw 'Configured host is already running.' }
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Parse($configuration.bindAddress),[int]$configuration.port)
        try { $listener.Start() } finally { $listener.Stop() }
        $secure = ConvertTo-SecureString (Get-Content -LiteralPath $secretsPath -Raw)
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $environment = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) | ConvertFrom-Json } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        foreach ($property in $environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name,[string]$property.Value,'Process') }
        $env:HOST=$configuration.bindAddress; $env:PORT=[string]$configuration.port; $env:TERMINAL_DATA_DIR=$configuration.dataDirectory; $env:TERMINAL_V4_RUNTIME_ROOT=$configuration.runtimeRoot
        New-Item -ItemType Directory -Path $configuration.dataDirectory -Force | Out-Null
        $process = Start-Process -FilePath $configuration.apiBinary -WorkingDirectory $configuration.runtimeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $configRoot 'host.stdout.log') -RedirectStandardError (Join-Path $configRoot 'host.stderr.log')
        $process.Refresh()
        [IO.File]::WriteAllText($runtimePath,(@{processId=$process.Id;apiBinary=$process.Path;startTicks=$process.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json))
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw 'Terminal v4 host exited with an error. Inspect host.stderr.log.' }
    } finally {
        if ($null -ne $lock) { $lock.Dispose() }
    }
}
