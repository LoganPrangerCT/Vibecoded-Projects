param([string]$Destination)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $workspace 'vendor\iot_driver.exe' }
$Destination = [IO.Path]::GetFullPath($Destination)
$expected = '73bad815658fa9aed3fa4d18a5123004afe4b263eb8c38c7b636f0b821f31aad'
if (Test-Path -LiteralPath $Destination) {
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $expected) { throw 'Existing hardware helper identity mismatch.' }
    Write-Output 'Verified hardware helper is already available.'
    return
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$download = Join-Path ([IO.Path]::GetTempPath()) ('R2Control-helper-' + [guid]::NewGuid().ToString('N') + '.zip')
$partial = $Destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/LoganPrangerCT/Vibecoded-Projects/releases/download/r2-control-v0.1.0/R2Control-Windows-x64.zip' -OutFile $download -TimeoutSec 180
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    $archive = [IO.Compression.ZipFile]::OpenRead($download)
    try {
        $entry = $archive.GetEntry('iot_driver.exe')
        if (-not $entry -or $entry.Length -ne 6695688) { throw 'The release does not contain the expected helper.' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $partial, $false)
    } finally { $archive.Dispose() }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $expected) { throw 'Downloaded hardware helper identity mismatch.' }
    Move-Item -LiteralPath $partial -Destination $Destination
    Write-Output 'Downloaded and verified hardware helper.'
} finally {
    foreach ($path in @($download, $partial)) { if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force } }
}
