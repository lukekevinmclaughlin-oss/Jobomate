using System.Collections.Generic;
using Jobomate.Contracts;

namespace Jobomate.Filters;

/// <summary>User-controlled search filters. Persisted as a <see cref="UserPreference"/>.</summary>
public sealed class SearchPreferences
{
    /// <summary>Acceptable required languages. Default: English only (strict).</summary>
    public List<string> AcceptedLanguages { get; set; } = new() { "English" };

    public LanguageMatchMode LanguageMode { get; set; } = LanguageMatchMode.StrictRequired;

    /// <summary>Empty = any work-location type.</summary>
    public List<WorkLocationType> WorkLocations { get; set; } = new();

    public bool IncludeUnclearWorkLocation { get; set; } = true;

    public string Location { get; set; } = "Munich";

    /// <summary>When true, exclude start-date risks; otherwise they are flagged but kept.</summary>
    public bool ExcludeStartDateRisk { get; set; }

    /// <summary>The common language options offered as a checklist.</summary>
    public static readonly string[] CommonLanguages =
    {
        "English", "German", "French", "Spanish", "Italian", "Portuguese", "Dutch", "Danish",
        "Swedish", "Norwegian", "Finnish", "Polish", "Czech", "Slovak", "Hungarian", "Romanian",
        "Bulgarian", "Greek", "Turkish", "Ukrainian", "Russian", "Arabic", "Hebrew", "Hindi",
        "Mandarin Chinese", "Japanese", "Korean",
    };
}
