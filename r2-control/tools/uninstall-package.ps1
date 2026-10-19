$ErrorActionPreference = 'Stop'
$directory = [IO.Path]::GetFullPath($PSScriptRoot)
if ($directory -eq [IO.Path]::GetPathRoot($directory) -or -not (Test-Path -LiteralPath (Join-Path $directory 'R2Control.exe'))) { throw 'The app installation could not be identified.' }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\R2Control'
$registered = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
if (-not $registered -or [IO.Path]::GetFullPath($registered.InstallLocation) -ne $directory) { throw 'This directory is not the registered R2 Control installation.' }
if (Get-Process -Name 'R2Control' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $directory 'R2Control.exe') }) { throw 'Close R2 Control before uninstalling it.' }
Get-Process -Name 'iot_driver' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $directory 'iot_driver.exe') } | Stop-Process
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'R2 Control.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $key -Force
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name R2Control -ErrorAction SilentlyContinue
# Keep data/ and all other unknown user files. Delete only our known package files.
foreach ($name in @('R2Control.exe','iot_driver.exe','libunwind.dll','WebView2Loader.dll','attack-shark.ico','README.md','LICENSE','THIRD_PARTY_NOTICES.md','THIRD-PARTY-LICENSES.txt','SHA256SUMS.txt','VERSION.txt','Install.ps1','Uninstall.ps1')) {
    $path = Join-Path $directory $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
}
