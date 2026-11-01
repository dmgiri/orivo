$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$installDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
$expectedTail = [IO.Path]::Combine('Programs', 'Orivo')
if (-not $installDirectory.EndsWith($expectedTail, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'This uninstaller can run only from the Orivo per-user installation folder.'
}

$answer = [Windows.Forms.MessageBox]::Show(
  'Remove Orivo for this Windows user? Your Orivo user settings will be kept.',
  'Uninstall Orivo',
  'YesNo',
  'Question'
)
if ($answer -ne 'Yes') { exit 0 }

$startMenuDirectory = Join-Path ([Environment]::GetFolderPath('Programs')) 'Orivo'
if (Test-Path -LiteralPath $startMenuDirectory) { Remove-Item -LiteralPath $startMenuDirectory -Recurse -Force }
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "timeout /t 1 /nobreak > nul & rmdir /s /q `"$installDirectory`"" -WindowStyle Hidden
