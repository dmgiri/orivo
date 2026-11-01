$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$installDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$result = [System.Windows.Forms.MessageBox]::Show(
    "Remove Orivo and its application files?`r`n`r`nYour settings in %APPDATA%\Orivo and connected project files will be kept.",
    'Uninstall Orivo',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question)
if ($result -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }

$escapedInstall = $installDirectory.Replace("'", "''")
$cleanup = @"
Start-Sleep -Seconds 2
`$installDirectory = '$escapedInstall'
`$startMenu = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)) 'Orivo'
`$desktopShortcut = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) 'Orivo.lnk'
`$registryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Orivo'
`$removed = `$false
for (`$attempt = 0; `$attempt -lt 6; `$attempt++) {
    try {
        if (Test-Path -LiteralPath `$installDirectory) { Remove-Item -LiteralPath `$installDirectory -Recurse -Force -ErrorAction Stop }
        `$removed = `$true
        break
    } catch { Start-Sleep -Seconds 1 }
}
if (`$removed) {
    Remove-Item -LiteralPath `$startMenu -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath `$desktopShortcut -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath `$registryKey -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('Orivo could not be removed. Close Orivo and try uninstalling again.', 'Uninstall Orivo', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanup))
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
    -ArgumentList @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) `
    -WindowStyle Hidden
