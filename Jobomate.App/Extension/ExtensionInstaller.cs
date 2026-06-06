using System;
using System.Diagnostics;
using System.IO;
using Jobomate.Persistence;

namespace Jobomate.Extension;

/// <summary>
/// Installs the bundled Chrome extension: copies it to a stable app-data folder and opens
/// Chrome at the extensions page so the user can "Load unpacked" and confirm permissions.
/// (Chrome's security model requires that user confirmation — it cannot be auto-clicked.)
/// </summary>
public static class ExtensionInstaller
{
    public static string ExtensionDir => Path.Combine(JobomatePaths.DataDir, "chrome-extension");

    public static (bool Ok, string Message, string Path) Install()
    {
        var dest = ExtensionDir;
        try
        {
            var src = Path.Combine(AppContext.BaseDirectory, "chrome-extension");
            if (!Directory.Exists(src) || !File.Exists(Path.Combine(src, "manifest.json")))
                return (false, "Bundled extension files weren't found next to the app. Rebuild Jobomate and retry.", dest);

            CopyDir(src, dest);
            OpenChrome();
            OpenFolder(dest);

            return (true,
                "Extension files written. Chrome was opened at chrome://extensions — turn on Developer mode (top-right), " +
                "click \"Load unpacked\", and select the folder that just opened in Finder. Chrome will ask you to confirm " +
                "permissions — that's the normal install step. Once loaded, the extension connects to Jobomate automatically.",
                dest);
        }
        catch (Exception ex)
        {
            return (false, ex.Message, dest);
        }
    }

    public static bool IsInstalledOnDisk() => File.Exists(Path.Combine(ExtensionDir, "manifest.json"));

    private static void OpenChrome()
    {
        try
        {
            Process.Start(new ProcessStartInfo("open")
            {
                ArgumentList = { "-a", "Google Chrome", "chrome://extensions/" },
                UseShellExecute = false,
            });
        }
        catch { /* Chrome may not be installed */ }
    }

    private static void OpenFolder(string dir)
    {
        try { Process.Start(new ProcessStartInfo("open") { ArgumentList = { dir }, UseShellExecute = false }); }
        catch { }
    }

    private static void CopyDir(string src, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.GetFiles(src))
            File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), overwrite: true);
        foreach (var dir in Directory.GetDirectories(src))
            CopyDir(dir, Path.Combine(dest, Path.GetFileName(dir)));
    }
}
