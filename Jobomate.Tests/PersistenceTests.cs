using Jobomate.Contracts;
using Jobomate.Persistence;
using Jobomate.Security;
using Xunit;

namespace Jobomate.Tests;

public class PersistenceTests
{
    [Fact]
    public void Repository_RoundTrips_Entity_WithEnumsAndLists()
    {
        var (db, keepalive) = JobomateDb.CreateInMemory();
        try
        {
            var repo = new Repository<JobPosting>(db);
            var job = new JobPosting
            {
                Company = "ACME Biotech",
                Title = "Growth Marketing Lead",
                WorkLocation = WorkLocationType.Remote,
                LanguageRequirements =
                {
                    new LanguageRequirement { Language = "English", Kind = LanguageRequirementKind.Required, Evidence = "Fluent English required." },
                },
            };
            repo.Upsert(job);

            var got = repo.Get(job.Id);
            Assert.NotNull(got);
            Assert.Equal("ACME Biotech", got!.Company);
            Assert.Equal(WorkLocationType.Remote, got.WorkLocation);
            Assert.Single(got.LanguageRequirements);
            Assert.Equal("English", got.LanguageRequirements[0].Language);
            Assert.Single(repo.All());

            repo.Delete(job.Id);
            Assert.Empty(repo.All());
        }
        finally
        {
            keepalive.Dispose();
        }
    }

    [Fact]
    public void AuditLog_Redacts_Secrets_BeforeStoring()
    {
        var log = new JobomateAuditLog();
        log.Record("email", "send", "smtp", detail: "auth used key sk-abcdef0123456789ABCDEFGH today");

        var entry = log.Recent(1)[0];
        Assert.Contains("<api-key>", entry.Detail);
        Assert.DoesNotContain("sk-abcdef0123456789ABCDEFGH", entry.Detail);
    }

    [Fact]
    public void InMemoryCredentialStore_Stores_Reads_Deletes()
    {
        ICredentialStore store = new InMemoryCredentialStore();
        store.StoreApiKey("OpenAI", "sk-secret-value");
        Assert.Equal("sk-secret-value", store.GetApiKey("OpenAI"));

        store.StoreCloudToken("smtp:me@example.com", "app-password");
        Assert.Equal("app-password", store.GetCloudToken("smtp:me@example.com"));

        store.DeleteApiKey("OpenAI");
        Assert.Null(store.GetApiKey("OpenAI"));
    }
}
