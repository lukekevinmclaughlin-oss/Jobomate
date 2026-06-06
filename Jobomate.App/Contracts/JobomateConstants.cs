using System;

namespace Jobomate.Contracts;

/// <summary>
/// Hard, app-wide constants. The availability date is a hard candidate
/// constraint that flows into ranking, filtering, and every generated draft.
/// </summary>
public static class JobomateConstants
{
    /// <summary>The candidate can start work only from this date. Hard rule everywhere.</summary>
    public static readonly DateOnly AvailabilityDate = new(2026, 10, 1);

    /// <summary>Human phrasing used verbatim in emails and cover letters.</summary>
    public const string AvailabilityText = "1 October 2026";

    /// <summary>The only honest German level (never claim fluency).</summary>
    public const string GermanLevel = "intermediate";

    /// <summary>
    /// Topics that must never appear in generated applications or LLM prompts.
    /// Used by the drafting guardrails and verified by tests.
    /// </summary>
    public static readonly string[] ForbiddenTopics =
    {
        "layoff", "laid off", "lay off", "redundancy", "redundant",
        "mental health", "therapy", "therapist", "depression", "anxiety",
        "burnout", "burn out", "unemploy", "fired", "dismissed",
        "sick leave", "personal circumstances", "private circumstances",
    };

    /// <summary>macOS Keychain service that holds all Jobomate secrets.</summary>
    public const string KeychainService = "com.jobomate.credentials";
}
