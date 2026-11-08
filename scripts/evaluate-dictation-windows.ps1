param([Parameter(Mandatory=$true)][string]$CorpusPath,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
function Emit($Value){[Console]::Out.WriteLine((ConvertTo-Json -InputObject $Value -Depth 12 -Compress));[Console]::Out.Flush()}
Add-Type -AssemblyName System.Speech
$corpus=Get-Content -LiteralPath $CorpusPath -Encoding utf8 -Raw | ConvertFrom-Json
$target=[System.IO.Path]::GetFullPath($OutputDirectory)
if(!(Test-Path -LiteralPath $target -PathType Container)){throw 'Choose an existing output directory.'}
$recognizers=@([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
$speaker=New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices=@($speaker.GetInstalledVoices() | Where-Object {$_.Enabled} | ForEach-Object {$_.VoiceInfo})
Emit @{type='metadata';recognizers=@($recognizers|ForEach-Object{@{id=$_.Id;language=$_.Culture.Name;description=$_.Description}});voices=@($voices|ForEach-Object{@{name=$_.Name;language=$_.Culture.Name}});platform=[System.Environment]::OSVersion.VersionString;runtime=[System.Environment]::Version.ToString();audioFormat='16kHz 16-bit mono PCM WAV';timingDefinition='Fresh recognition instance and dictation grammar initialization in one process; OS/model caches uncontrolled. Recognition processing runs on a completed WAV, not live speech.'}
try{
 foreach($case in $corpus.cases){
  if($case.id -notmatch '^[a-z0-9-]{1,80}$'){throw 'Invalid corpus case identifier.'}
  $recognizer=$recognizers|Where-Object {$_.Culture.Name -eq $case.language}|Select-Object -First 1
  $voice=$voices|Where-Object {$_.Culture.Name -eq $case.language}|Select-Object -First 1
  if(!$recognizer -or !$voice){Emit @{type='case';id=$case.id;language=$case.language;skipped=$true;reason='No installed recognizer and TTS voice pair for this exact language.'};continue}
  $engine=$null
  try{
   $wave=Join-Path $target ($case.id+'.wav')
   $speaker.SelectVoice($voice.Name);$speaker.Rate=0
   $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
   $speaker.SetOutputToWaveFile($wave,$format)
   $synthesis=[System.Diagnostics.Stopwatch]::StartNew();$speaker.Speak([string]$case.reference);$synthesis.Stop();$speaker.SetOutputToNull()
   $init=[System.Diagnostics.Stopwatch]::StartNew()
   $engine=New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)
   $grammar=New-Object System.Speech.Recognition.DictationGrammar
   $engine.LoadGrammar($grammar);$engine.InitialSilenceTimeout=[TimeSpan]::FromSeconds(8);$engine.BabbleTimeout=[TimeSpan]::FromSeconds(8);$engine.EndSilenceTimeout=[TimeSpan]::FromMilliseconds(700);$engine.EndSilenceTimeoutAmbiguous=[TimeSpan]::FromMilliseconds(900)
   $init.Stop();$engine.SetInputToWaveFile($wave)
   $processing=[System.Diagnostics.Stopwatch]::StartNew();$recognized=$engine.Recognize([TimeSpan]::FromSeconds(20));$processing.Stop()
   $result=@{type='case';id=$case.id;language=$case.language;recognizer=$recognizer.Id;voice=$voice.Name;wave=[System.IO.Path]::GetFileName($wave);text='';confidence=$null;coldLoadMs=$init.Elapsed.TotalMilliseconds;recognitionProcessingMs=$processing.Elapsed.TotalMilliseconds;synthesisMs=$synthesis.Elapsed.TotalMilliseconds;audioDurationMs=$null}
   if($recognized){$result.text=$recognized.Text;$result.confidence=$recognized.Confidence;$result.audioDurationMs=$recognized.Audio.Duration.TotalMilliseconds}
   Emit $result
  }catch{Emit @{type='case';id=$case.id;language=$case.language;text='';error=$_.Exception.Message;recognizer=$recognizer.Id;voice=$voice.Name}}
  finally{if($engine){$engine.Dispose()}}
 }
}finally{$speaker.Dispose()}
