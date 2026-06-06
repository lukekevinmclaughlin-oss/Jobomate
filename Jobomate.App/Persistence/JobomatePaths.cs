using System;
using System.IO;

namespace Jobomate.Persistence;

/// <summary>
/// Centralizes the macOS app-data layout under
/// <c>~/Library/Application Support/Jobomate</c>. Tests/CI can redirect the whole
/// tree with the <c>JOBOMATE_DATA_DIR</c> environment variable so real user data
/// is never touched. Secrets never live here — they go to the Keychain.
/// </summary>
public static class JobomatePaths
{
    public static string DataDir { get; }

    static JobomatePaths()
    {
        var overrideDir = Environment.GetEnvironmentVariable("JOBOMATE_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(overrideDir))
        {
            DataDir = overrideDir!;
        }
        else
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            DataDir = Path.Combine(home, "Library", "Application Support", "Jobomate");
        }
    }

    public static string DbPath => Path.Combine(DataDir, "jobomate.db");
    public static string DocumentsDir => Path.Combine(DataDir, "documents");
    public static string CoverLettersDir => Path.Combine(DataDir, "cover-letters");
    public static string AuditDir => Path.Combine(DataDir, "audit");
    public static string BrowserProfileDir => Path.Combine(DataDir, "browser-profile");
    public static string ImportsDir => Path.Combine(DataDir, "imports");

    public static string EnsureDir(string dir)
    {
        Directory.CreateDirectory(dir);
        return dir;
    }
}
