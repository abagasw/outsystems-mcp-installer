param(
    [string]$Destination,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Install-Application([string]$Path) {
    $node = Get-Command node.exe -ErrorAction Stop
    $version = & $node.Source -p 'parseInt(process.versions.node)'
    if ($LASTEXITCODE -ne 0 -or [int]$version -lt 20) {
        throw 'Install Node.js 20 or newer, then run this installer again.'
    }
    $output = & $node.Source (Join-Path $root 'bin\install.js') $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
    Write-Output ($output -join "`n")
}

try {
    if ($Destination) {
        Install-Application $Destination
    } else {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()

        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'Install OutSystems MCP'
        $form.ClientSize = New-Object System.Drawing.Size(600, 220)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.AutoScaleMode = 'Dpi'
        $form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

        $heading = New-Object System.Windows.Forms.Label
        $heading.Text = 'Choose the installation folder'
        $heading.Location = New-Object System.Drawing.Point(24, 24)
        $heading.AutoSize = $true
        $form.Controls.Add($heading)

        $location = New-Object System.Windows.Forms.TextBox
        $location.Location = New-Object System.Drawing.Point(24, 60)
        $location.Size = New-Object System.Drawing.Size(440, 28)
        $location.Text = Join-Path $env:LOCALAPPDATA 'Programs\OutSystems MCP'
        $location.AccessibleName = 'Installation folder'
        $form.Controls.Add($location)

        $browse = New-Object System.Windows.Forms.Button
        $browse.Text = 'Browse...'
        $browse.Location = New-Object System.Drawing.Point(476, 57)
        $browse.Size = New-Object System.Drawing.Size(100, 32)
        $browse.Add_Click({
            $picker = New-Object System.Windows.Forms.FolderBrowserDialog
            $picker.Description = 'Choose a new or empty folder for OutSystems MCP.'
            if (Test-Path -LiteralPath $location.Text -PathType Container) {
                $picker.SelectedPath = $location.Text
            }
            try {
                if ($picker.ShowDialog($form) -eq 'OK') { $location.Text = $picker.SelectedPath }
            } finally { $picker.Dispose() }
        })
        $form.Controls.Add($browse)

        $description = New-Object System.Windows.Forms.Label
        $description.Text = 'Next: choose your MCP client and add an ODC tenant or Service Studio port.'
        $description.Location = New-Object System.Drawing.Point(24, 104)
        $description.Size = New-Object System.Drawing.Size(552, 48)
        $form.Controls.Add($description)

        $cancel = New-Object System.Windows.Forms.Button
        $cancel.Text = 'Cancel'
        $cancel.Location = New-Object System.Drawing.Point(360, 168)
        $cancel.Size = New-Object System.Drawing.Size(100, 32)
        $cancel.DialogResult = 'Cancel'
        $form.CancelButton = $cancel
        $form.Controls.Add($cancel)

        $install = New-Object System.Windows.Forms.Button
        $install.Text = 'Install'
        $install.Location = New-Object System.Drawing.Point(476, 168)
        $install.Size = New-Object System.Drawing.Size(100, 32)
        $form.AcceptButton = $install
        $install.Add_Click({
            $install.Enabled = $false
            $browse.Enabled = $false
            $location.ReadOnly = $true
            $install.Text = 'Installing...'
            $form.Refresh()
            try {
                Install-Application $location.Text
                $form.Tag = [System.IO.Path]::GetFullPath($location.Text.Trim())
                $form.DialogResult = 'OK'
            } catch {
                [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Installation failed', 'OK', 'Error') | Out-Null
            } finally {
                $install.Enabled = $true
                $browse.Enabled = $true
                $location.ReadOnly = $false
                $install.Text = 'Install'
            }
        })
        $form.Controls.Add($install)

        if ($form.ShowDialog() -ne 'OK') { $form.Dispose(); exit 0 }
        $Destination = [string]$form.Tag
        $form.Dispose()
    }

    if (-not $NoLaunch) {
        $launcher = Join-Path $Destination 'Launch.vbs'
        Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"{0}"' -f $launcher)
    }
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
