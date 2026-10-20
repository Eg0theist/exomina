using System;
using System.Speech.Recognition;
public static class ExominaSpeechSignals {
  public static void Attach(SpeechRecognitionEngine engine) {
    engine.SpeechDetected += (sender, args) => {
      Console.Out.WriteLine("{\"type\":\"speech\"}");
      Console.Out.Flush();
    };
  }
}
