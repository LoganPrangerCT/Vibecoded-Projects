param([string]$Executable)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $Executable) { $Executable = Join-Path $workspace 'dist\R2Control\R2Control.exe' }
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$testRoot = Join-Path $workspace ('data\smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $Executable) 'iot_driver.exe') -Destination $testRoot
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public static class R2WindowTest {
    public delegate bool EnumWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int max);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr window, int index);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    // Retain a native handle while the child is alive. PowerShell's redirected
    // Process.ExitCode can be null; reopening an exited PID risks a reused PID.
    public static IntPtr OpenQuery(int pid) { return OpenProcess(0x1000, false, pid); }
    public static int ExitCode(IntPtr handle) {
        uint code; return GetExitCodeProcess(handle, out code) ? (int)code : -1;
    }
    public static void CloseQuery(IntPtr handle) { if (handle != IntPtr.Zero) CloseHandle(handle); }
    static bool IsNonRenderingEventTarget(IntPtr window) {
        var kind = new StringBuilder(256); GetClassName(window, kind, 256);
        // Tao's message target deliberately has WS_VISIBLE for WM_PAINT delivery.
        // Its transparent layered, non-activating tool-window surface is not drawn.
        const int required = 0x08000000 | 0x00080000 | 0x00000020 | 0x00000080;
        return kind.ToString() == "Tao Thread Event Target" && (GetWindowLongW(window, -20) & required) == required;
    }
    public static bool IsForeground(uint process) {
        uint actual; GetWindowThreadProcessId(GetForegroundWindow(), out actual); return actual == process;
    }
    public static int VisibleWindows(uint process) {
        int count = 0;
        EnumWindows((window, data) => { uint actual; GetWindowThreadProcessId(window, out actual); if (actual == process && IsWindowVisible(window) && !IsNonRenderingEventTarget(window)) count++; return true; }, IntPtr.Zero);
        return count;
    }
    public static string[] VisibleDetails(uint process) {
        var rows = new List<string>();
        EnumWindows((window, data) => {
            uint actual; GetWindowThreadProcessId(window, out actual);
            if (actual == process && IsWindowVisible(window)) {
                var title = new StringBuilder(256); var kind = new StringBuilder(256); Rect rect;
                GetWindowText(window, title, 256); GetClassName(window, kind, 256); GetWindowRect(window, out rect);
                rows.Add(kind + " | " + title + " | " + rect.left + "," + rect.top + "," + rect.right + "," + rect.bottom);
            }
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }
}
'@
$previousPath = $env:PATH
$previousRoot = $env:R2_HOME
$previousWrites = $env:R2_SMOKE_LOCAL_WRITES
$foregroundObserved = $false
$visibleObserved = $false
$samples = 0
$visibleDetails = [System.Collections.Generic.HashSet[string]]::new()
$exitQueryHandle = [IntPtr]::Zero
try {
    $env:R2_HOME = $testRoot
    $env:R2_SMOKE_LOCAL_WRITES = '1'
    # Prove the package works without Cargo extending the DLL search path.
    $env:PATH = Join-Path $env:SystemRoot 'System32'
    $process = Start-Process -FilePath $Executable -ArgumentList '--ui-smoke' -WorkingDirectory (Split-Path -Parent $Executable) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot 'stdout.log') -RedirectStandardError (Join-Path $testRoot 'stderr.log')
    $exitQueryHandle = [R2WindowTest]::OpenQuery($process.Id)
    if ($exitQueryHandle -eq [IntPtr]::Zero) { if (-not $process.HasExited) { Stop-Process -Id $process.Id }; throw 'Could not retain the hidden test process handle.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        $samples++
        if ([R2WindowTest]::IsForeground($process.Id)) { $foregroundObserved = $true }
        if ([R2WindowTest]::VisibleWindows($process.Id) -gt 0) {
            $visibleObserved = $true
            foreach ($detail in [R2WindowTest]::VisibleDetails($process.Id)) { $null = $visibleDetails.Add($detail) }
        }
        Start-Sleep -Milliseconds 50
        $process.Refresh()
    }
    if (-not $process.HasExited) { Stop-Process -Id $process.Id; throw 'Hidden desktop test did not exit within 45 seconds.' }
    $process.WaitForExit()
    $exitCode = [R2WindowTest]::ExitCode($exitQueryHandle)
} finally {
    [R2WindowTest]::CloseQuery($exitQueryHandle)
    $env:PATH = $previousPath
    $env:R2_HOME = $previousRoot
    $env:R2_SMOKE_LOCAL_WRITES = $previousWrites
}
$resultPath = Join-Path $testRoot 'data\ui-smoke-result.json'
$result = if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json } else { @{ ok = $false; error = 'No new smoke result was written.' } }
$report = [ordered]@{
    ok = ($exitCode -eq 0 -and $result.ok -and -not $foregroundObserved -and -not $visibleObserved)
    executable = $Executable
    sha256 = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
    exitCode = $exitCode
    foregroundObserved = $foregroundObserved
    visibleWindowObserved = $visibleObserved
    visibleDetails = @($visibleDetails)
    visibilityExclusion = 'Only Tao Thread Event Target with transparent/layered/no-activate/tool-window styles; see Tao event_loop.rs create_event_target_window.'
    samples = $samples
    cleanDllPath = $true
    isolatedDataRoot = $testRoot
    ui = $result
}
$evidence = Join-Path $workspace 'data\deployment-ui-test.json'
$report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $evidence -Encoding utf8
$report | ConvertTo-Json -Depth 20
if (-not $report.ok) { throw "Desktop test failed. See $evidence and $testRoot" }
