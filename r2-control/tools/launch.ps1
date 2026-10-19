param([switch]$Background)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $workspace 'dist\R2Control\R2Control.exe'
if (-not (Test-Path -LiteralPath $executable)) {
    throw 'Build the desktop app first with tools\package.ps1. See README.md.'
}
$launch = @{ FilePath = $executable; WorkingDirectory = (Split-Path -Parent $executable) }
if ($Background) { $launch.ArgumentList = '--background'; $launch.WindowStyle = 'Hidden' }
Start-Process @launch | Out-Null
