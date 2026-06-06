using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Llm.Adapters;

// CLI pipe + Terminal connection types. Receives a shell runner by
// constructor so the characterization harness can swap in a fake. The
// runner contract is "given a command template, the latest user prompt,
// and a timeout, return the stdout."
public sealed class CliAdapter : ILlmAdapter
{
    public delegate Task<string> ShellRunner(string command, string prompt, int timeoutSeconds, CancellationToken ct);

    private readonly ShellRunner _run;
    public CliAdapter(ShellRunner run) => _run = run;

    public string Name => "cli";
    public LlmCapability Capabilities =>
        LlmCapability.Chat |
        LlmCapability.LocalOnly;

    public async Task<string> Send(
        LlmEndpoint endpoint,
        IReadOnlyList<IReadOnlyDictionary<string, string>> messages,
        IReadOnlyList<JsonElement> tools,
        LlmCallOptions options,
        CancellationToken ct)
    {
        // Endpoint.Url carries the command template. The latest user
        // message is the prompt to substitute. Auth fields and tools are
        // unused: CLI tools do not currently support structured tool calls.
        var prompt = "";
        for (var i = messages.Count - 1; i >= 0; i--)
        {
            if (messages[i].TryGetValue("role", out var r) && r == "user")
            {
                prompt = messages[i].TryGetValue("content", out var c) ? c : "";
                break;
            }
        }
        var timeoutFromOptions = options.MaxOutputTokens.HasValue ? Math.Min(options.MaxOutputTokens.Value, 600) : 120;
        return await _run(endpoint.Url, prompt, timeoutFromOptions, ct).ConfigureAwait(false);
    }
}
