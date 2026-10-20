param(
  [ValidateSet('status','listen','speak')][string]$Mode,
  [string]$InputPath = '',
  [string]$OutputPath = ''
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Send-Event($Data) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Data -Compress -Depth 6))
  [Console]::Out.Flush()
}
$engine = $null
$speaker = $null
try {
  Add-Type -AssemblyName System.Speech
  if ($Mode -eq 'status') {
    $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object {
      @{ id = $_.Id; language = $_.Culture.Name; name = $_.Culture.DisplayName }
    })
    $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = @($speaker.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
      @{ id = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name; name = $_.VoiceInfo.Name }
    })
    Send-Event @{ type = 'status'; available = ($recognizers.Count -gt 0); recognizers = $recognizers; voices = $voices; language = [System.Globalization.CultureInfo]::CurrentUICulture.Name }
    exit 0
  }
  $request = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
  if ($Mode -eq 'speak') {
    $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
    if ($request.voice) { $speaker.SelectVoice([string]$request.voice) }
    $speaker.Rate = [int]$request.rate
    if ($OutputPath) { $speaker.SetOutputToWaveFile($OutputPath) } else { $speaker.SetOutputToDefaultAudioDevice() }
    Send-Event @{ type = 'ready' }
    $speaker.Speak([string]$request.text)
    Send-Event @{ type = 'done' }
    exit 0
  }
  $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $request.language } | Select-Object -First 1
  if (!$recognizer) { throw 'This Windows speech language is not installed. Choose an installed language in Settings > Voice.' }
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)
  # Emit speech detection from a CLR handler: PowerShell event script blocks
  # cannot reliably run on the recognizer's background callback thread.
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-interop/Speech.dll')
  [ExominaSpeechSignals]::Attach($engine)
  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $engine.LoadGrammar($grammar)
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(8)
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(700)
  $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(900)
  if ($InputPath) { $engine.SetInputToWaveFile($InputPath) } else { $engine.SetInputToDefaultAudioDevice() }
  Send-Event @{ type = 'ready' }
  do {
    $recognized = $engine.Recognize([TimeSpan]::FromSeconds(15))
    if ($recognized -and $recognized.Text) {
      if ($recognized.Confidence -ge 0.25) {
        Send-Event @{ type = 'transcript'; text = $recognized.Text; confidence = $recognized.Confidence }
      } else { Send-Event @{ type = 'unclear' } }
    } else { Send-Event @{ type = 'quiet' } }
  } while (!$InputPath)
  Send-Event @{ type = 'done' }
} catch {
  Send-Event @{ type = 'error'; message = $_.Exception.Message }
  exit 1
} finally {
  if ($engine) { $engine.Dispose() }
  if ($speaker) { $speaker.Dispose() }
}
