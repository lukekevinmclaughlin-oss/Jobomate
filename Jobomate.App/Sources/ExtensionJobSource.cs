using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Extension;

namespace Jobomate.Sources;

/// <summary>
/// Surfaces jobs extracted by the Jobomate Chrome extension: postings the user sent from
/// the popup, plus any URLs the app asked the extension to research in the logged-in browser.
/// </summary>
public sealed class ExtensionJobSource : IJobSource
{
    private readonly ExtensionBridge _bridge;
    public ExtensionJobSource(ExtensionBridge bridge) => _bridge = bridge;

    public string Name => "Browser extension";
    public bool RequiresConfiguration => true; // needs the extension installed + connected

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        var results = new List<JobPosting>(_bridge.DrainPushed());
        if (_bridge.IsConnected && request.JobUrls.Count > 0)
            results.AddRange(await _bridge.CollectAsync(request.JobUrls, ct).ConfigureAwait(false));
        return results;
    }
}
