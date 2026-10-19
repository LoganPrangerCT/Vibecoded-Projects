param([string]$Installer)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $Installer) { $Installer = Join-Path $workspace 'dist\release\R2Control-Setup.exe' }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$root = Join-Path $workspace ('data\installer-test-' + [guid]::NewGuid().ToString('N'))
$target = Join-Path $root 'installed'
New-Item -ItemType Directory -Path (Join-Path $target 'data') -Force | Out-Null
$sentinel = Join-Path $target 'data\preserve.txt'
'keep user data' | Set-Content -LiteralPath $sentinel
function Run-Installer([string]$Directory, [bool]$ExpectSuccess) {
    $arguments = '-Silent -NoRegister -NoLaunch -SkipPrerequisites -InstallDirectory "' + $Directory + '"'
    $process = Start-Process -FilePath $Installer -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if (($process.ExitCode -eq 0) -ne $ExpectSuccess) { throw "Unexpected installer exit code $($process.ExitCode). See $env:TEMP\R2Control-install.log" }
}
Run-Installer $target $true
foreach ($name in @('R2Control.exe','iot_driver.exe','WebView2Loader.dll','libunwind.dll','VERSION.txt','Uninstall.ps1','LICENSE')) {
    if (-not (Test-Path -LiteralPath (Join-Path $target $name))) { throw "Installer omitted $name." }
}
if ((Get-Content -LiteralPath $sentinel -Raw).Trim() -ne 'keep user data') { throw 'Installation changed user data.' }
# A late write failure must restore earlier files and leave existing data intact.
$readme = Join-Path $target 'README.md'
$dll = Join-Path $target 'WebView2Loader.dll'
'previous installed readme' | Set-Content -LiteralPath $readme
'previous installed dll (not executed)' | Set-Content -LiteralPath $dll
$oldDll = (Get-FileHash -LiteralPath $dll).Hash
$lock = [IO.File]::Open($dll, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { Run-Installer $target $false } finally { $lock.Dispose() }
if ((Get-Content -LiteralPath $readme -Raw).Trim() -ne 'previous installed readme' -or (Get-FileHash -LiteralPath $dll).Hash -ne $oldDll) { throw 'Failed upgrade did not restore the previous files.' }
Run-Installer $target $true
if ((Get-FileHash -LiteralPath $dll).Hash -eq $oldDll) { throw 'A subsequent valid update did not repair the old file.' }
if ((Get-Content -LiteralPath $sentinel -Raw).Trim() -ne 'keep user data') { throw 'Upgrade changed user data.' }
$foreign = Join-Path $root 'unrelated'
New-Item -ItemType Directory -Path $foreign | Out-Null
'unrelated file' | Set-Content -LiteralPath (Join-Path $foreign 'README.md')
Run-Installer $foreign $false
if ((Get-Content -LiteralPath (Join-Path $foreign 'README.md') -Raw).Trim() -ne 'unrelated file') { throw 'Installer changed an unrelated directory.' }
Write-Output 'Installer checks passed: complete extraction, preserved user data, locked-file upgrade rollback, retry, unrelated-directory rejection. No registration, app launch, runtime installation or hardware writes.'
