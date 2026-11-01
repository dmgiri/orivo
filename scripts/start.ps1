param([switch]$NoDialog)
$ErrorActionPreference = 'Stop'
$traceAtlasRoot = Split-Path -Parent $PSScriptRoot
$traceAtlasLogs = Join-Path $traceAtlasRoot '.tmp\launcher'
try {
    $traceAtlasNode = (Get-Command node.exe -ErrorAction Stop).Source
    $traceAtlasVersion = (& $traceAtlasNode --version).TrimStart('v')
    if ([version]$traceAtlasVersion -lt [version]'24.13.0') {
        throw 'Orivo needs Node.js 24.13 or newer. Install the current Node.js LTS, then launch again.'
    }
    New-Item -ItemType Directory -Path $traceAtlasLogs -Force | Out-Null
    $traceAtlasToken = [guid]::NewGuid().ToString('N')
    $traceAtlasStatus = Join-Path $traceAtlasLogs ($traceAtlasToken + '.json')
    $traceAtlasOutput = Join-Path $traceAtlasLogs ($traceAtlasToken + '.out.log')
    $traceAtlasError = Join-Path $traceAtlasLogs ($traceAtlasToken + '.err.log')
    $traceAtlasPreviousToken = $env:TRACE_ATLAS_LAUNCH_TOKEN
    try {
        $env:TRACE_ATLAS_LAUNCH_TOKEN = $traceAtlasToken
        $traceAtlasLauncher = Start-Process -FilePath $traceAtlasNode -ArgumentList ('"' + (Join-Path $PSScriptRoot 'launch.mjs') + '"') -WorkingDirectory $traceAtlasRoot -WindowStyle Hidden -RedirectStandardOutput $traceAtlasOutput -RedirectStandardError $traceAtlasError -PassThru
    } finally {
        $env:TRACE_ATLAS_LAUNCH_TOKEN = $traceAtlasPreviousToken
    }
    $traceAtlasDeadline = [DateTime]::UtcNow.AddSeconds(25)
    while ([DateTime]::UtcNow -lt $traceAtlasDeadline) {
        if (Test-Path -LiteralPath $traceAtlasStatus) {
            $traceAtlasResult = $null
            try { $traceAtlasResult = Get-Content -LiteralPath $traceAtlasStatus -Raw | ConvertFrom-Json } catch { }
            if ($traceAtlasResult.state -eq 'ready' -and $traceAtlasResult.visible -eq $true) {
                Write-Output 'Orivo is open.'
                exit 0
            }
            if ($traceAtlasResult.state -eq 'existing') {
                Write-Output 'Orivo is already running. Its window has been requested.'
                exit 0
            }
            if ($traceAtlasResult.state -eq 'error') { throw $traceAtlasResult.message }
        }
        $traceAtlasLauncher.Refresh()
        if ($traceAtlasLauncher.HasExited) { throw 'The desktop launcher stopped before its window was ready.' }
        Start-Sleep -Milliseconds 100
    }
    throw 'The desktop window did not become visible within 25 seconds.'
} catch {
    $traceAtlasMessage = 'Orivo could not start.' + [Environment]::NewLine + [Environment]::NewLine + $_.Exception.Message
    if ($traceAtlasError -and (Test-Path -LiteralPath $traceAtlasError)) {
        $traceAtlasTail = (Get-Content -LiteralPath $traceAtlasError -Tail 10) -join [Environment]::NewLine
        if ($traceAtlasTail) { $traceAtlasMessage += [Environment]::NewLine + [Environment]::NewLine + $traceAtlasTail }
    }
    $traceAtlasMessage += [Environment]::NewLine + [Environment]::NewLine + 'Startup logs: ' + $traceAtlasLogs
    [Console]::Error.WriteLine($traceAtlasMessage)
    if (-not $NoDialog) {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($traceAtlasMessage, 'Orivo', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    }
    exit 1
}
