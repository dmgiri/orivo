param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Icon,
  [Parameter(Mandatory=$true)][string]$VersionInfo
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrivoResourceEditor {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool EndUpdateResource(IntPtr update, bool discard);
}
'@
function Set-Resource($handle, [int]$type, [int]$name, [byte[]]$data) {
  if (-not [OrivoResourceEditor]::UpdateResource($handle, [IntPtr]$type, [IntPtr]$name, 1033, $data, $data.Length)) {
    throw "Cannot update executable resource ($type/$name): $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
}
$exePath = [IO.Path]::GetFullPath($Executable)
if ([IO.Path]::GetFileName($exePath) -ne 'Orivo.exe') { throw 'Only the staged Orivo.exe may be branded.' }
[byte[]]$ico = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath($Icon))
$count = [BitConverter]::ToUInt16($ico, 4)
$group = New-Object IO.MemoryStream
$writer = New-Object IO.BinaryWriter($group)
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$count)
$update = [OrivoResourceEditor]::BeginUpdateResource($exePath, $false)
if ($update -eq [IntPtr]::Zero) { throw "Cannot open staged executable resources: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$committed = $false
try {
  for ($i=0; $i -lt $count; $i++) {
    $position = 6 + 16*$i
    $size = [BitConverter]::ToUInt32($ico, $position+8)
    $offset = [BitConverter]::ToUInt32($ico, $position+12)
    [byte[]]$data = New-Object byte[] $size
    [Array]::Copy($ico, [long]$offset, $data, 0, [long]$size)
    Set-Resource $update 3 (201+$i) $data
    $writer.Write($ico, $position, 12)
    $writer.Write([UInt16](201+$i))
  }
  Set-Resource $update 14 1 $group.ToArray()
  Set-Resource $update 16 1 ([IO.File]::ReadAllBytes([IO.Path]::GetFullPath($VersionInfo)))
  if (-not [OrivoResourceEditor]::EndUpdateResource($update, $false)) { throw 'Cannot commit executable branding.' }
  $committed = $true
} finally {
  if (-not $committed) { [void][OrivoResourceEditor]::EndUpdateResource($update, $true) }
  $writer.Dispose(); $group.Dispose()
}
$info = [Diagnostics.FileVersionInfo]::GetVersionInfo($exePath)
if ($info.ProductName -ne 'Orivo' -or $info.OriginalFilename -ne 'Orivo.exe') { throw 'Staged executable branding did not verify.' }
Write-Output "Windows executable branded: $($info.ProductName) $($info.FileVersion)"
