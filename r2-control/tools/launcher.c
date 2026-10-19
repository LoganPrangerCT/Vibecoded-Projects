#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>

// Keep the packaged program, its DLLs and existing user data together.
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR arguments, int show) {
    (void)instance;
    (void)previous;
    WCHAR *folder = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 32768 * sizeof(WCHAR));
    if (!folder) return ERROR_NOT_ENOUGH_MEMORY;
    DWORD length = GetModuleFileNameW(NULL, folder, 32768);
    if (!length || length >= 32768) return ERROR_BAD_PATHNAME;
    WCHAR *separator = wcsrchr(folder, L'\\');
    if (!separator) return ERROR_BAD_PATHNAME;
    separator[1] = 0;
    const WCHAR suffix[] = L"dist\\R2Control\\R2Control.exe";
    size_t base = wcslen(folder), suffixLength = wcslen(suffix);
    if (base + suffixLength >= 32768) return ERROR_BAD_PATHNAME;
    memcpy(folder + base, suffix, sizeof(suffix));
    size_t commandLength = wcslen(folder) + wcslen(arguments) + 4;
    if (commandLength > 32767) return ERROR_BAD_ARGUMENTS;
    WCHAR *command = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, commandLength * sizeof(WCHAR));
    if (!command) return ERROR_NOT_ENOUGH_MEMORY;
    command[0] = L'"';
    wcscpy(command + 1, folder);
    wcscat(command, L"\" ");
    wcscat(command, arguments);
    WCHAR *directory = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 32768 * sizeof(WCHAR));
    if (!directory) return ERROR_NOT_ENOUGH_MEMORY;
    wcscpy(directory, folder);
    *wcsrchr(directory, L'\\') = 0;
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = (WORD)show;
    if (!CreateProcessW(folder, command, NULL, NULL, FALSE, 0, NULL, directory, &startup, &process)) {
        DWORD error = GetLastError();
        MessageBoxW(NULL, L"R2 Control could not start. Keep this launcher beside the dist folder and rebuild with tools\\package.ps1 if needed.", L"R2 Control", MB_OK | MB_ICONERROR);
        return (int)error;
    }
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD result = 1;
    GetExitCodeProcess(process.hProcess, &result);
    CloseHandle(process.hProcess);
    HeapFree(GetProcessHeap(), 0, directory);
    HeapFree(GetProcessHeap(), 0, command);
    HeapFree(GetProcessHeap(), 0, folder);
    return (int)result;
}
