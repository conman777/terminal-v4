$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$scriptPath = Join-Path $PSScriptRoot 'remote-desktop-helper.ps1'
function Invoke-Helper([string]$body, [string]$mode) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = 'powershell.exe'
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" ' + $mode
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    $process.StandardInput.Write($body); $process.StandardInput.Close()
    $memory = New-Object IO.MemoryStream
    $process.StandardOutput.BaseStream.CopyTo($memory)
    $errorText=$process.StandardError.ReadToEnd()
    if (-not $process.WaitForExit(15000)) {$process.Kill(); throw 'Helper timed out.'}
    @{code=$process.ExitCode;bytes=$memory.ToArray();error=$errorText}
}
foreach ($inputValue in @(
    @{kind='pointer';x=0.5;y=0.5;action='click'},
    @{kind='key';key='Enter';modifiers=@('Control')},
    @{kind='text';text='Synthetic Unicode validation: '+[char]0x00A3+[char]0x03BB},
    @{kind='wheel';delta=-120}
)) {
    $result=Invoke-Helper (@{command='input';input=$inputValue} | ConvertTo-Json -Depth 4 -Compress) '-DryRun'
    if($result.code -ne 0){throw $result.error}
    $value=[Text.Encoding]::UTF8.GetString($result.bytes) | ConvertFrom-Json
    if(-not $value.accepted -or -not $value.dryRun){throw 'Dry run did not stay isolated.'}
}
foreach($inputValue in @(@{kind='pointer';x=-1;y=0.5;action='click'},@{kind='key';key='Run-Process';modifiers=@()},@{kind='wheel';delta=1})) {
    $result=Invoke-Helper (@{command='input';input=$inputValue} | ConvertTo-Json -Depth 4 -Compress) '-DryRun'
    if($result.code -eq 0){throw 'Invalid input was accepted.'}
}
$frame=Invoke-Helper '{"command":"frame"}' '-Fixture'
if($frame.code -ne 0){throw $frame.error}
if($frame.bytes.Length -lt 100 -or $frame.bytes[0] -ne 255 -or $frame.bytes[1] -ne 216){throw 'Synthetic frame is not JPEG.'}
$memory=New-Object IO.MemoryStream(,$frame.bytes)
$image=[Drawing.Image]::FromStream($memory)
try {if($image.Width -ne 320 -or $image.Height -ne 180){throw 'Fixture frame geometry changed.'}} finally {$image.Dispose();$memory.Dispose()}
Write-Output 'Desktop helper dry-run validation and synthetic JPEG passed. No screen capture or input was performed.'
