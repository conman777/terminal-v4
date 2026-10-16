[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$SourcePath,
    [string]$BootstrapPython = 'python',
    [switch]$Plan,
    [switch]$Verify
)
$ErrorActionPreference = 'Stop'
$resolvedSource = [IO.Path]::GetFullPath($SourcePath)
foreach ($requiredFile in @('pyproject.toml', 'uv.lock', 'hermes_cli/main.py', 'pm/operations.py')) {
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedSource $requiredFile) -PathType Leaf)) {
        throw "Not a complete Hermes source tree: missing $requiredFile at $resolvedSource"
    }
}
$runtimeRoot = Join-Path $resolvedSource '.venv'
$runtimeExecutable = Join-Path $runtimeRoot 'Scripts/hermes.exe'
$bootstrapHome = Join-Path $resolvedSource '.setup-home'
if ($Plan) {
    [ordered]@{ source=$resolvedSource; executable=$runtimeExecutable; pythonVersion='3.14'; bootstrapHome=$bootstrapHome } | ConvertTo-Json
    return
}
if (-not $Verify) {
    if (-not (Test-Path -LiteralPath $runtimeRoot)) {
        $originalHome = $env:HERMES_HOME
        $env:HERMES_HOME = $bootstrapHome
        Push-Location -LiteralPath $resolvedSource
        try {
            $buildScript = @"
from pathlib import Path
from pm.operations import build_environment
build_environment(source=Path.cwd(), out=Path.cwd() / '.venv', extras=('all',), explicit=True)
"@
            $buildScript | & $BootstrapPython -
            if ($LASTEXITCODE -ne 0) { throw 'Pinned Hermes dependency installation failed. No ready runtime was published.' }
        } finally {
            Pop-Location
            $env:HERMES_HOME = $originalHome
        }
    }
}
if (-not (Test-Path -LiteralPath $runtimeExecutable -PathType Leaf)) {
    throw "Hermes launcher is missing at $runtimeExecutable. Inspect the failed environment before retrying."
}
$runtimePython = Join-Path $runtimeRoot 'Scripts/python.exe'
& $runtimePython -c 'import sys, openai, prompt_toolkit, hermes_cli, tools; assert sys.version_info[:2] == (3, 14), "Hermes requires Python 3.14"'
if ($LASTEXITCODE -ne 0) { throw 'Hermes Python version or core dependency imports failed; the runtime is not ready.' }
& $runtimeExecutable --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Hermes CLI help failed; the runtime is not ready.' }
& $runtimeExecutable chat --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Hermes chat help failed; the runtime is not ready.' }
[ordered]@{ source=$resolvedSource; executable=$runtimeExecutable; verified=$true; environmentVariable='HERMES_EXECUTABLE' } | ConvertTo-Json
Write-Host ('Set HERMES_EXECUTABLE to: ' + $runtimeExecutable)
