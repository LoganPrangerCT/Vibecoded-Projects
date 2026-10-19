#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <wchar.h>
#include <stdio.h>

static BOOL unpack(HINSTANCE instance, int id, const WCHAR *path) {
    HRSRC resource = FindResourceW(instance, MAKEINTRESOURCEW(id), MAKEINTRESOURCEW(10));
    if (!resource) return FALSE;
    DWORD length = SizeofResource(instance, resource), written = 0;
    const void *data = LockResource(LoadResource(instance, resource));
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (!data || file == INVALID_HANDLE_VALUE) return FALSE;
    BOOL ok = WriteFile(file, data, length, &written, NULL) && written == length;
    CloseHandle(file);
    return ok;
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR arguments, int show) {
    (void)previous; (void)show;
    WCHAR temp[MAX_PATH] = {0}, directory[MAX_PATH] = {0}, zip[MAX_PATH] = {0}, script[MAX_PATH] = {0}, system[MAX_PATH] = {0};
    WCHAR guidText[40]; GUID guid;
    WCHAR *command = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 32768 * sizeof(WCHAR));
    DWORD result = 1;
    BOOL directoryCreated = FALSE;
    BOOL silent = wcsstr(arguments, L"-Silent") != NULL;
    if (!command || !GetTempPathW(MAX_PATH, temp) || FAILED(CoCreateGuid(&guid)) ||
        !StringFromGUID2(&guid, guidText, 40)) goto failed;
    if (swprintf(directory, MAX_PATH, L"%lsR2Control-%ls", temp, guidText) < 0 ||
        !CreateDirectoryW(directory, NULL)) goto failed;
    directoryCreated = TRUE;
    if (swprintf(zip, MAX_PATH, L"%ls\\payload.zip", directory) < 0 ||
        swprintf(script, MAX_PATH, L"%ls\\install.ps1", directory) < 0 ||
        !unpack(instance, 101, zip) || !unpack(instance, 102, script) ||
        !GetSystemDirectoryW(system, MAX_PATH)) goto failed;
    if (swprintf(command, 32768, L"\"%ls\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"%ls\" -ArchivePath \"%ls\" %ls", system, script, zip, arguments) < 0) goto failed;
    STARTUPINFOW startup = {0}; PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, directory, &startup, &process)) goto failed;
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    GetExitCodeProcess(process.hProcess, &result);
    CloseHandle(process.hProcess);
    DeleteFileW(zip); DeleteFileW(script); RemoveDirectoryW(directory);
    if (result != 0) goto failed;
    HeapFree(GetProcessHeap(), 0, command);
    if (!silent) MessageBoxW(NULL, L"R2 Control is installed. You can open it from the Windows Start menu.", L"R2 Control", MB_OK | MB_ICONINFORMATION);
    return 0;
failed:
    if (directoryCreated) { DeleteFileW(zip); DeleteFileW(script); RemoveDirectoryW(directory); }
    if (command) HeapFree(GetProcessHeap(), 0, command);
    if (!silent) MessageBoxW(NULL, L"Installation did not finish. See R2Control-install.log in your Windows temporary folder for details. Close R2 Control before reinstalling.", L"R2 Control", MB_OK | MB_ICONERROR);
    return (int)(result ? result : 1);
}
