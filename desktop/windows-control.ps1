param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('screenshot', 'click', 'type', 'key')]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    $payloadText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
    $payload = ConvertFrom-Json -InputObject $payloadText
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-interop/Desktop.dll')
    [void][ExominaDesktopNative]::SetProcessDPIAware()
    if ($null -ne $payload.targetWindow -and [string]$payload.targetWindow -ne '') {
        $targetHandle = [IntPtr]::new([long]::Parse([string]$payload.targetWindow))
        if (-not [ExominaDesktopNative]::IsWindow($targetHandle)) { throw 'The inspected target window is no longer available. Start with a new screenshot.' }
        if ([ExominaDesktopNative]::GetForegroundWindow() -ne $targetHandle) {
            if (-not [ExominaDesktopNative]::SetForegroundWindow($targetHandle)) { throw 'Windows refused to restore the inspected target window. Focus it manually and try again.' }
            Start-Sleep -Milliseconds 180
            if ([ExominaDesktopNative]::GetForegroundWindow() -ne $targetHandle) { throw 'Target focus changed before input. No input was sent.' }
        }
    }
    $screenBounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $boundsObject = @{
        left = $screenBounds.Left
        top = $screenBounds.Top
        width = $screenBounds.Width
        height = $screenBounds.Height
    }
    if ($screenBounds.Width -le 0 -or $screenBounds.Height -le 0) { throw 'No interactive desktop is available.' }

    if ($Action -eq 'screenshot') {
        if ([long]$screenBounds.Width * [long]$screenBounds.Height -gt 80000000) { throw 'The virtual desktop is too large to capture safely.' }
        $bitmap = [System.Drawing.Bitmap]::new($screenBounds.Width, $screenBounds.Height)
        $graphics = $null
        $stream = $null
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.CopyFromScreen($screenBounds.Left, $screenBounds.Top, 0, 0, $screenBounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
            $stream = [System.IO.MemoryStream]::new()
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            $result = @{ bounds = $boundsObject; windowId = [ExominaDesktopNative]::GetForegroundWindow().ToInt64().ToString(); image = [System.Convert]::ToBase64String($stream.ToArray()) }
        }
        finally {
            if ($null -ne $graphics) { $graphics.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
            $bitmap.Dispose()
        }
    }
    else {
        if ($null -eq $payload.expectedBounds) { throw 'A recent screenshot is required before desktop input.' }
        foreach ($dimension in @('left', 'top', 'width', 'height')) {
            if ($payload.expectedBounds.$dimension -ne $boundsObject[$dimension]) { throw 'Monitor layout changed. Capture a new screenshot before continuing.' }
        }
        if ($Action -eq 'click') {
            if ($payload.x -isnot [ValueType] -or $payload.y -isnot [ValueType] -or
                [double]$payload.x -ne [Math]::Floor([double]$payload.x) -or [double]$payload.y -ne [Math]::Floor([double]$payload.y) -or
                $payload.x -lt 0 -or $payload.y -lt 0 -or $payload.x -ge $screenBounds.Width -or $payload.y -ge $screenBounds.Height) {
                throw 'Click coordinates are outside the desktop screenshot.'
            }
            $screenX = [int]$payload.x + $screenBounds.Left
            $screenY = [int]$payload.y + $screenBounds.Top
            if (-not [ExominaDesktopNative]::SetCursorPos($screenX, $screenY)) { throw 'Windows refused to move the pointer.' }
            [ExominaDesktopNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            [ExominaDesktopNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        }
        elseif ($Action -eq 'type') {
            if ($payload.text -isnot [string] -or $payload.text.Length -gt 20000) { throw 'Text must be a string of at most 20000 characters.' }
            # Treat the payload as literal text, never as SendKeys command syntax.
            # Clipboard contents are neither read nor replaced.
            $literalText = $payload.text.Replace("`r`n", "`n").Replace("`r", "`n")
            $sendKeysText = [System.Text.StringBuilder]::new()
            foreach ($character in $literalText.ToCharArray()) {
                if ($character -eq "`n") { [void]$sendKeysText.Append('{ENTER}') }
                elseif ($character -eq "`t") { [void]$sendKeysText.Append('{TAB}') }
                elseif ([char]::IsControl($character)) { throw 'Text contains an unsupported control character.' }
                elseif ('+^%~(){}[]'.Contains([string]$character)) { [void]$sendKeysText.Append('{' + $character + '}') }
                else { [void]$sendKeysText.Append($character) }
            }
            if ($sendKeysText.Length -gt 0) { [System.Windows.Forms.SendKeys]::SendWait($sendKeysText.ToString()) }
        }
        else {
            $keyMap = @{
                Enter = '{ENTER}'; Tab = '{TAB}'; Escape = '{ESC}'; Backspace = '{BACKSPACE}'
                Delete = '{DELETE}'; ArrowLeft = '{LEFT}'; ArrowRight = '{RIGHT}'; ArrowUp = '{UP}'; ArrowDown = '{DOWN}'
                Home = '{HOME}'; End = '{END}'; PageUp = '{PGUP}'; PageDown = '{PGDN}'; Space = ' '
                'Control+A' = '^a'; 'Control+C' = '^c'; 'Control+V' = '^v'; 'Control+Z' = '^z'; 'Control+Y' = '^y'; 'Control+S' = '^s'
                'Alt+Tab' = '%{TAB}'; 'Shift+Tab' = '+{TAB}'
            }
            if ($payload.key -isnot [string] -or -not $keyMap.ContainsKey($payload.key)) { throw 'Unsupported keyboard key.' }
            [System.Windows.Forms.SendKeys]::SendWait($keyMap[$payload.key])
        }
        $result = @{ completed = $true; action = $Action; windowId = [ExominaDesktopNative]::GetForegroundWindow().ToInt64().ToString(); note = 'Input was sent to Windows. Inspect a fresh screenshot to verify its effect.' }
    }
    $result | ConvertTo-Json -Depth 5 -Compress
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
