using System;
using System.Collections.Generic;
using Jobomate.Contracts;

namespace Jobomate.Filters;

/// <summary>User-controlled search filters. Persisted as a <see cref="UserPreference"/>.</summary>
public sealed class SearchPreferences
{
    /// <summary>Who is using the app — job seeker (find jobs) or recruiter (find candidates).
    /// Flips the framing of every LLM prompt and UI label; the pipeline itself is shared.</summary>
    public AppMode Mode { get; set; } = AppMode.JobSeeker;

    /// <summary>Acceptable required languages. Default: English only (strict).</summary>
    public List<string> AcceptedLanguages { get; set; } = new() { "English" };

    public LanguageMatchMode LanguageMode { get; set; } = LanguageMatchMode.StrictRequired;

    /// <summary>Empty = any work-location type.</summary>
    public List<WorkLocationType> WorkLocations { get; set; } = new();

    public bool IncludeUnclearWorkLocation { get; set; } = true;

    /// <summary>Empty = anywhere (derived from the candidate's profile/CV when set).</summary>
    public string Location { get; set; } = "";

    /// <summary>Free-text persona + guidelines the user gives the assistant. Injected into the chat
    /// system prompt and the drafting prompts so the LLM treats it as its own rules for the job hunt.</summary>
    public string LlmPersona { get; set; } = "";

    /// <summary>The exact websites the assistant pulls from / searches inside via the browser
    /// extension. Like the persona, this scopes the LLM's research — injected into its context and
    /// used as the default research targets.</summary>
    public List<string> SearchSites { get; set; } = new();

    /// <summary>When true, exclude start-date risks; otherwise they are flagged but kept.</summary>
    public bool ExcludeStartDateRisk { get; set; }

    /// <summary>Optional candidate availability date. Null = available anytime (default — no start-date risk).</summary>
    public DateOnly? AvailableFrom { get; set; }

    /// <summary>Greenhouse board slugs to pull (e.g. "stripe", "airbnb").</summary>
    public List<string> GreenhouseCompanies { get; set; } = new();

    /// <summary>Lever board slugs to pull.</summary>
    public List<string> LeverCompanies { get; set; } = new();

    /// <summary>The common language options offered as a checklist.</summary>
    public static readonly string[] CommonLanguages =
    {
        "English", "German", "French", "Spanish", "Italian", "Portuguese", "Dutch", "Danish",
        "Swedish", "Norwegian", "Finnish", "Polish", "Czech", "Slovak", "Hungarian", "Romanian",
        "Bulgarian", "Greek", "Turkish", "Ukrainian", "Russian", "Arabic", "Hebrew", "Hindi",
        "Mandarin Chinese", "Japanese", "Korean",
    };
}
