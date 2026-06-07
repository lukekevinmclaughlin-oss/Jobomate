using Jobomate.Contracts;

namespace Jobomate.Profile;

/// <summary>
/// The neutral default profile. Jobomate does not assume any profession — the real profile comes
/// from the candidate's own CV (loaded in the chat or Settings → Candidate profile). When no CV has
/// been parsed yet this blank seed is used: it invents no skills, employers, industries, or
/// languages beyond English, so the app prompts the user to load a CV / fill the profile rather than
/// drafting on fabricated facts.
/// </summary>
public static class CandidateProfileDefaults
{
    public static CandidateProfile Known() => new()
    {
        Id = "profile",
        FullName = "",
        Headline = "",
        Location = "",
        Summary = "",
        YearsExperience = 0,
        Languages =
        {
            new CandidateLanguage { Language = "English", Level = "native" },
        },
        FromFallback = true,
    };
}
