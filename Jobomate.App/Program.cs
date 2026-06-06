using Avalonia;

namespace Jobomate;

/// <summary>
/// Entry point for the Jobomate desktop app. Configures the Avalonia desktop
/// lifetime (Fluent theme + Inter font) and hands control to <see cref="App"/>.
/// </summary>
internal static class Program
{
    [STAThread]
    public static void Main(string[] args) =>
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
