# Custom Yes/No dialog for sandbox decisions.
#
# Called by src/win-sandbox.js:
#   powershell -File win-dialog.ps1 -Message "..." -Command "..." [-Detail "..."]
#
# Shows the command in a black-framed box above the message text, so the user
# always sees exactly what is about to run. Prints "yes" or "no" on stdout.
# The server sets CFM_DIALOG_AUTO=yes|no to answer without a window (tests).

param(
  [Parameter(Mandatory = $true)][string]$Message,
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$Detail = ""
)

$ErrorActionPreference = "SilentlyContinue"

$auto = $env:CFM_DIALOG_AUTO
if ($auto -eq "yes" -or $auto -eq "no") {
  $auto.Trim().ToLowerInvariant()
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Claude Desktop spawns MCP servers with a hidden main window; without this
# the form would inherit the hidden state and never appear on screen.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DialogWin32 {
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$form = New-Object System.Windows.Forms.Form
$form.Text = "Claude File Manager"
$form.ClientSize = New-Object System.Drawing.Size(584, 348)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(22, 23, 25)
$form.ForeColor = [System.Drawing.Color]::FromArgb(236, 234, 230)
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

# The command itself, in a black frame with a monospace font.
$cmdBox = New-Object System.Windows.Forms.TextBox
$cmdBox.Multiline = $true
$cmdBox.ReadOnly = $true
$cmdBox.Text = $Command
$cmdBox.Font = New-Object System.Drawing.Font("Consolas", 9.75)
$cmdBox.BackColor = [System.Drawing.Color]::FromArgb(8, 9, 10)
$cmdBox.ForeColor = [System.Drawing.Color]::FromArgb(236, 234, 230)
$cmdBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$cmdBox.Location = New-Object System.Drawing.Point(24, 16)
$cmdBox.Size = New-Object System.Drawing.Size(536, 84)
$cmdBox.WordWrap = $true
$cmdBox.ScrollBars = "Vertical"
$form.Controls.Add($cmdBox)

$label = New-Object System.Windows.Forms.Label
$label.Text = $Message
$label.Location = New-Object System.Drawing.Point(24, 112)
$label.Size = New-Object System.Drawing.Size(536, 44)
$form.Controls.Add($label)

$detailTop = 160
if ($Detail) {
  $detailLabel = New-Object System.Windows.Forms.Label
  $detailLabel.Text = $Detail
  $detailLabel.ForeColor = [System.Drawing.Color]::FromArgb(155, 152, 148)
  $detailLabel.Location = New-Object System.Drawing.Point(24, 160)
  $detailLabel.Size = New-Object System.Drawing.Size(536, 118)
  $form.Controls.Add($detailLabel)
  $detailTop = 160
}

$yesButton = New-Object System.Windows.Forms.Button
$yesButton.Text = "Yes"
$yesButton.Location = New-Object System.Drawing.Point(352, 296)
$yesButton.Size = New-Object System.Drawing.Size(100, 34)
$yesButton.BackColor = [System.Drawing.Color]::FromArgb(217, 119, 87)
$yesButton.ForeColor = [System.Drawing.Color]::FromArgb(26, 15, 10)
$yesButton.FlatStyle = "Flat"
$yesButton.Add_Click({ $form.Tag = "yes"; $form.Close() })
$form.Controls.Add($yesButton)

$noButton = New-Object System.Windows.Forms.Button
$noButton.Text = "No"
$noButton.Location = New-Object System.Drawing.Point(460, 296)
$noButton.Size = New-Object System.Drawing.Size(100, 34)
$noButton.BackColor = [System.Drawing.Color]::FromArgb(41, 43, 48)
$noButton.ForeColor = [System.Drawing.Color]::FromArgb(236, 234, 230)
$noButton.FlatStyle = "Flat"
$noButton.Add_Click({ $form.Tag = "no"; $form.Close() })
$form.Controls.Add($noButton)
$form.AcceptButton = $yesButton
$form.CancelButton = $noButton

# Claude Desktop spawns MCP servers with a hidden main window; the form
# would inherit that hidden state and never appear. Re-show it from the
# Load event, after the handle exists.
$form.Add_Load({
  [void][DialogWin32]::ShowWindow($form.Handle, 9) # SW_RESTORE
})

# Never leave a dialog hanging forever: if nobody answers in 5 minutes,
# treat it as "No".
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300000
$timer.Add_Tick({ $form.Tag = "no"; $form.Close() })
$timer.Start()

[void]$form.ShowDialog()
if ($form.Tag -eq "yes") { "yes" } else { "no" }
