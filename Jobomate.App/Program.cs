using System;
using System.Linq;
using Avalonia;
using Jobomate.Engine;

namespace Jobomate;

/// <summary>
/// Entry point. Two modes:
///  • default → the Avalonia desktop UI (standalone Jobomate).
///  • <c>--engine</c> → the headless Jobomate engine: an HTTP server that exposes every job-automation
///    flow (chat, CV, research, drafts, approval, send, email, browser) over localhost, so the merged
///    Electron app (LM_Browser shell) can drive it. The engine also controls the in-app browser over
///    the Electron control server (port 9222), exactly like the standalone LmBrowser client.
/// </summary>
internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Contains("--engine"))
        {
            var port = ArgInt(args, "--port", 9223);
            EngineServer.Run(port);
            return;
        }

        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    private static int ArgInt(string[] args, string name, int dflt)
    {
        var i = Array.IndexOf(args, name);
        if (i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var v)) return v;
        var eq = args.FirstOrDefault(a => a.StartsWith(name + "=", StringComparison.Ordinal));
        if (eq is not null && int.TryParse(eq[(name.Length + 1)..], out var v2)) return v2;
        return dflt;
    }

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
