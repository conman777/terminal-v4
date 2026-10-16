$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'setup-hermes.ps1'
$sourcePath = Join-Path ([IO.Path]::GetTempPath()) ('hermes setup ' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $sourcePath | Out-Null
try {
    foreach ($name in @('pyproject.toml', 'uv.lock', 'hermes_cli/main.py', 'pm/operations.py')) {
        $filePath = Join-Path $sourcePath $name
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($filePath)) -Force | Out-Null
        Set-Content -LiteralPath $filePath -Value ''
    }
    $priorHome = $env:HERMES_HOME
    $result = & $scriptPath -SourcePath $sourcePath -Plan | ConvertFrom-Json
    $expected = [IO.Path]::Combine($sourcePath, '.venv', 'Scripts', 'hermes.exe')
    if ($result.executable -ne $expected) { throw 'Executable does not preserve the exact source path.' }
    if ($result.source -ne [IO.Path]::GetFullPath($sourcePath)) { throw 'Source path was not canonicalized.' }
    if ($result.pythonVersion -ne '3.14') { throw 'The runtime must use the upstream Python version.' }
    if ($env:HERMES_HOME -ne $priorHome) { throw 'Setup changed the caller Hermes home.' }
    $rejected = $false
    try { & $scriptPath -SourcePath (Join-Path $sourcePath 'missing') -Plan } catch { $rejected = $true }
    if (-not $rejected) { throw 'A missing source tree was accepted.' }
    Write-Output 'Hermes setup plan validation passed.'
} finally {
    $resolvedPath = [IO.Path]::GetFullPath($sourcePath)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedPath.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Temporary test path escaped.' }
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}
