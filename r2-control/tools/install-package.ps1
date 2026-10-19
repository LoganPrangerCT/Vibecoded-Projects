param(
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\R2Control'),
    [switch]$NoRegister, [switch]$NoLaunch, [switch]$SkipPrerequisites, [switch]$Silent
)
$ErrorActionPreference = 'Stop'
$stage = Join-Path ([IO.Path]::GetTempPath()) ('R2Control-stage-' + [guid]::NewGuid().ToString('N'))
$log = Join-Path ([IO.Path]::GetTempPath()) 'R2Control-install.log'
function Install-MicrosoftRuntime([string]$Url, [string]$Name, [string[]]$Arguments) {
    $installer = Join-Path $stage $Name
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $installer -TimeoutSec 180
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation[, ]') {
        throw "The Microsoft signature on $Name could not be verified."
    }
    $process = Start-Process -FilePath $installer -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -notin @(0, 1638, 3010)) { throw "$Name failed with exit code $($process.ExitCode)." }
}
function Has-WebView {
    foreach ($key in @('HKCU:\Software\Microsoft\EdgeUpdate\Clients\*', 'HKLM:\Software\Microsoft\EdgeUpdate\Clients\*', 'HKLM:\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\*')) {
        if (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue | Where-Object { $_.name -like '*WebView2*' -and $_.pv -and $_.pv -ne '0.0.0.0' }) { return $true }
    }
    return $false
}
try {
    $InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
    if ($InstallDirectory -eq [IO.Path]::GetPathRoot($InstallDirectory)) { throw 'Cannot install in a drive root.' }
    if (Test-Path -LiteralPath $InstallDirectory) {
        $existing = @(Get-ChildItem -LiteralPath $InstallDirectory -Force | Where-Object Name -ne 'data')
        if ($existing.Count -and (-not (Test-Path -LiteralPath (Join-Path $InstallDirectory 'R2Control.exe')) -or -not (Test-Path -LiteralPath (Join-Path $InstallDirectory 'SHA256SUMS.txt')))) { throw 'The selected directory contains files from another installation. Choose an empty directory.' }
    }
    if (Get-Process -Name 'R2Control' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $InstallDirectory 'R2Control.exe') }) { throw 'Close R2 Control before updating it.' }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $payload = Join-Path $stage 'payload'
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $payload
    $expected = @{}
    foreach ($line in Get-Content -LiteralPath (Join-Path $payload 'SHA256SUMS.txt')) {
        if ($line -notmatch '^([a-fA-F0-9]{64})  ([A-Za-z0-9._-]+)$') { throw 'Invalid package checksum entry.' }
        $expected[$Matches[2]] = $Matches[1]
    }
    foreach ($file in Get-ChildItem -LiteralPath $payload) {
        if ($file.PSIsContainer) { throw 'Unexpected subdirectory in installer payload.' }
        if ($file.Name -eq 'SHA256SUMS.txt') { continue }
        if (-not $expected.ContainsKey($file.Name) -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne $expected[$file.Name]) { throw "Package integrity check failed: $($file.Name)." }
    }
    foreach ($name in @('R2Control.exe','iot_driver.exe','libunwind.dll','WebView2Loader.dll','Uninstall.ps1','attack-shark.ico')) {
        if (-not (Test-Path -LiteralPath (Join-Path $payload $name) -PathType Leaf)) { throw "Required package file is missing: $name." }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $payload 'iot_driver.exe') -Algorithm SHA256).Hash -ne '73bad815658fa9aed3fa4d18a5123004afe4b263eb8c38c7b636f0b821f31aad') { throw 'Hardware helper identity mismatch.' }
    if (-not $SkipPrerequisites) {
        if (-not (Has-WebView)) { Install-MicrosoftRuntime 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' 'WebView2Setup.exe' @('/silent','/install') }
        $vcRuntime = Join-Path ([Environment]::GetFolderPath('SystemX86')) 'vcruntime140.dll'
        if (-not (Test-Path -LiteralPath $vcRuntime)) { Install-MicrosoftRuntime 'https://aka.ms/vs/17/release/vc_redist.x86.exe' 'VCSetup.exe' @('/install','/quiet','/norestart') }
    }
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
    $backupDirectory = Join-Path $stage 'previous'
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $files = @(Get-ChildItem -LiteralPath $payload -File)
    $oldFiles = @{}
    foreach ($file in $files) {
        $target = Join-Path $InstallDirectory $file.Name
        if (Test-Path -LiteralPath $target -PathType Leaf) { Copy-Item -LiteralPath $target -Destination (Join-Path $backupDirectory $file.Name); $oldFiles[$file.Name]=$true }
    }
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\R2Control'
    $link = Join-Path ([Environment]::GetFolderPath('Programs')) 'R2 Control.lnk'
    $hadLink = Test-Path -LiteralPath $link -PathType Leaf
    $hadKey = Test-Path -LiteralPath $key
    $previousRegistry = @{}
    if (-not $NoRegister) {
        if ($hadLink) { Copy-Item -LiteralPath $link -Destination (Join-Path $backupDirectory 'shortcut.lnk') }
        if ($hadKey) { $registry=Get-Item -LiteralPath $key; foreach ($name in $registry.GetValueNames()) { $previousRegistry[$name]=@{Value=$registry.GetValue($name);Kind=$registry.GetValueKind($name).ToString()} } }
    }
    try {
        foreach ($file in $files) {
            $target = Join-Path $InstallDirectory $file.Name
            if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Get-FileHash -LiteralPath $target).Hash -eq (Get-FileHash -LiteralPath $file.FullName).Hash) { continue }
            Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        }
    if (-not $NoRegister) {
        $programs = [Environment]::GetFolderPath('Programs')
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $programs 'R2 Control.lnk'))
        $shortcut.TargetPath = Join-Path $InstallDirectory 'R2Control.exe'
        $shortcut.WorkingDirectory = $InstallDirectory
        $shortcut.IconLocation = Join-Path $InstallDirectory 'attack-shark.ico'
        $shortcut.Save()
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\R2Control'
        New-Item -Path $key -Force | Out-Null
        $uninstall = '"' + (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstallDirectory 'Uninstall.ps1') + '"'
        $version = (Get-Content -LiteralPath (Join-Path $payload 'VERSION.txt') -Raw).Trim()
        if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version.' }
        foreach ($entry in @{ DisplayName='R2 Control'; DisplayVersion=$version; Publisher='LoganPrangerCT'; InstallLocation=$InstallDirectory; DisplayIcon=(Join-Path $InstallDirectory 'attack-shark.ico'); UninstallString=$uninstall }.GetEnumerator()) { New-ItemProperty -Path $key -Name $entry.Key -Value $entry.Value -PropertyType String -Force | Out-Null }
        New-ItemProperty -Path $key -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
    }
    } catch {
        $installError = $_
        foreach ($file in $files) {
            $target = Join-Path $InstallDirectory $file.Name
            if ($oldFiles.ContainsKey($file.Name)) {
                $backup = Join-Path $backupDirectory $file.Name
                if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Get-FileHash -LiteralPath $target).Hash -eq (Get-FileHash -LiteralPath $backup).Hash) { continue }
                Copy-Item -LiteralPath $backup -Destination $target -Force
            } elseif (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
        }
        if (-not $NoRegister) {
            if ($hadLink) { Copy-Item -LiteralPath (Join-Path $backupDirectory 'shortcut.lnk') -Destination $link -Force } elseif (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
            if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Force }
            if ($hadKey) { New-Item -Path $key -Force | Out-Null; foreach ($name in $previousRegistry.Keys) { New-ItemProperty -Path $key -Name $name -Value $previousRegistry[$name].Value -PropertyType $previousRegistry[$name].Kind -Force | Out-Null } }
        }
        throw $installError
    }
    'Installation completed.' | Set-Content -LiteralPath $log
    if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $InstallDirectory 'R2Control.exe') -WorkingDirectory $InstallDirectory -WindowStyle Hidden | Out-Null }
} catch {
    $_.ToString() | Set-Content -LiteralPath $log
    Write-Error $_
    exit 1
} finally {
    # Only remove the unique directory created by this invocation.
    $stageFull = [IO.Path]::GetFullPath($stage)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($stageFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($stageFull) -match '^R2Control-stage-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $stageFull)) { Remove-Item -LiteralPath $stageFull -Recurse -Force }
}
