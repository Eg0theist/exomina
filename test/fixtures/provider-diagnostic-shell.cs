using System;
using System.IO;
using System.Text;

// This shell executes nothing. It only records arguments and returns made-up
// output, so a diagnostic regression test can never read the real registry.
class ProviderDiagnosticShell {
    static int Main(string[] args) {
        string log = Environment.GetEnvironmentVariable("EXOMINA_DIAGNOSTIC_SHELL_LOG");
        if (!String.IsNullOrEmpty(log)) {
            File.AppendAllText(log, Environment.CommandLine.Replace("\r", "\\r").Replace("\n", "\\n") + Environment.NewLine, Encoding.UTF8);
        }
        string command = String.Join(" ", args);
        if (command.IndexOf("exomina-diagnostic-sentinel", StringComparison.Ordinal) >= 0) {
            Console.WriteLine("synthetic-shell-forwarded");
        } else if (command.IndexOf("QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid", StringComparison.OrdinalIgnoreCase) >= 0) {
            Console.WriteLine("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography");
            Console.WriteLine("    MachineGuid    REG_SZ    synthetic-machine-id");
        }
        return 0;
    }
}
