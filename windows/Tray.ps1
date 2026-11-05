$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$root = Split-Path $PSScriptRoot -Parent
$data = Join-Path $root 'data'
$readyFile = Join-Path $data 'desktop.json'
$hash = [System.Security.Cryptography.SHA256]::Create()
try {
    $bytes = $hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))
    $mutexName = 'Local\OutSystemsMCP-' + ([System.BitConverter]::ToString($bytes) -replace '-', '')
} finally { $hash.Dispose() }
$created = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$created)
$backend = $null
$timer = $null
$icon = $null
$setup = $null

function Open-Dashboard([string]$Url) {
    $address = [uri]$Url
    if ($address.Scheme -ne 'http' -or $address.Host -ne '127.0.0.1') {
        throw 'The dashboard address must be a local HTTP URL.'
    }
    Start-Process $address.AbsoluteUri
}

try {
    if (-not $created) {
        if (Test-Path -LiteralPath $readyFile) {
            $running = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
            Open-Dashboard $running.url
        } else {
            [System.Windows.Forms.MessageBox]::Show('OutSystems MCP is starting. Use its tray icon when ready.', 'OutSystems MCP') | Out-Null
        }
        return
    }

    $installation = Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $installation.nodePath -PathType Leaf)) {
        throw 'Node.js is no longer at its installation path. Install Node.js and reinstall into a new folder.'
    }
    if (Test-Path -LiteralPath $readyFile) { Remove-Item -LiteralPath $readyFile }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $installation.nodePath
    $info.Arguments = '"{0}" ui --port 0 --no-open --ready-file "{1}"' -f (Join-Path $root 'bin\oms.js'), $readyFile
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardOutput = $true
    $info.EnvironmentVariables['OMS_HOME'] = $data
    $info.EnvironmentVariables['OMS_INSTALL_DIR'] = $root
    $backend = [System.Diagnostics.Process]::Start($info)

    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $readyFile)) {
        if ($backend.WaitForExit(100)) { throw $backend.StandardError.ReadToEnd() }
        if ($deadline.Elapsed.TotalSeconds -gt 15) { throw 'The dashboard did not start within 15 seconds.' }
    }
    $ready = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
    $url = [string]$ready.url

    $context = New-Object System.Windows.Forms.ApplicationContext
    $icon = New-Object System.Windows.Forms.NotifyIcon
    # Use the Windows application icon as an explicit placeholder until branding is supplied.
    $icon.Icon = [System.Drawing.SystemIcons]::Application
    $icon.Text = 'OutSystems MCP'
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $open = $menu.Items.Add('Open dashboard')
    $open.Add_Click({ Open-Dashboard $url })
    $null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    $quit = $menu.Items.Add('Quit OutSystems MCP')
    $quit.Add_Click({ $context.ExitThread() })
    $icon.ContextMenuStrip = $menu
    $icon.Add_DoubleClick({ Open-Dashboard $url })

    # A setup window prevents a hidden orphan if the browser closes before the first server is saved.
    $setup = New-Object System.Windows.Forms.Form
    $setup.Text = 'OutSystems MCP setup'
    $setup.ClientSize = New-Object System.Drawing.Size(440, 140)
    $setup.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $setup.StartPosition = 'CenterScreen'
    $setup.FormBorderStyle = 'FixedDialog'
    $setup.MaximizeBox = $false
    $label = New-Object System.Windows.Forms.Label
    $label.Text = 'Add your first server in the dashboard. Then this window moves to the Windows system tray.'
    $label.Location = New-Object System.Drawing.Point(20, 20)
    $label.Size = New-Object System.Drawing.Size(400, 50)
    $setup.Controls.Add($label)
    $reopen = New-Object System.Windows.Forms.Button
    $reopen.Text = 'Open setup'
    $reopen.Location = New-Object System.Drawing.Point(284, 88)
    $reopen.Size = New-Object System.Drawing.Size(136, 32)
    $reopen.Add_Click({ Open-Dashboard $url })
    $setup.Controls.Add($reopen)
    $context.MainForm = $setup

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1000
    $timer.Add_Tick({
        if ($backend.HasExited) {
            $timer.Stop()
            [System.Windows.Forms.MessageBox]::Show('The local dashboard stopped. Launch OutSystems MCP again.', 'OutSystems MCP', 'OK', 'Error') | Out-Null
            $context.ExitThread()
            return
        }
        $registryFile = Join-Path $data 'servers.json'
        if (-not (Test-Path -LiteralPath $registryFile)) { return }
        try {
            $registry = Get-Content -LiteralPath $registryFile -Raw | ConvertFrom-Json
            $count = @($registry.servers.PSObject.Properties).Count
            if ($count -gt 0 -and -not $icon.Visible) {
                $icon.Visible = $true
                $setup.Hide()
                $icon.ShowBalloonTip(3000, 'OutSystems MCP', 'Server saved. Open the dashboard from this icon.', 'Info')
            }
            $icon.Text = 'OutSystems MCP: {0} saved, {1} selected' -f $count, @($registry.active).Count
        } catch { $icon.Text = 'OutSystems MCP: registry unavailable' }
    })
    $timer.Start()
    Open-Dashboard $url
    $setup.Show()
    [System.Windows.Forms.Application]::Run($context)
} catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'OutSystems MCP', 'OK', 'Error') | Out-Null
} finally {
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($icon) { $icon.Visible = $false; $icon.Dispose() }
    if ($setup) { $setup.Dispose() }
    if ($created -and $backend -and -not $backend.HasExited) {
        try {
            Invoke-RestMethod -Uri ($url.TrimEnd('/') + '/api/shutdown') -Method Post -Headers @{ 'x-oms' = '1' } -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
        } catch { }
        if (-not $backend.WaitForExit(10000)) { $backend.Kill(); $backend.WaitForExit() }
    }
    if ($backend) { $backend.Dispose() }
    if ($created) {
        if (Test-Path -LiteralPath $readyFile) { Remove-Item -LiteralPath $readyFile }
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
