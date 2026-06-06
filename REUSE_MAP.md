# REUSE_MAP — infrastructure ported from MultiAgentOS_Mac_OS

Jobomate reuses battle-tested infrastructure from the (read-only) reference repo
`/Users/lukemclaughlin/Documents/GitHub/MultiAgentOS_Mac_OS`. "Port" = copy file,
rewrite namespace `MultiAgentOS.AvaloniaShell.* / MultiAgentOS.Contracts` →
`Jobomate.*`, no behavioral rewrite unless noted. "Reimplement" = new focused code
modeled on the reference (the original was entangled with a 200-property god-object).

## Ported as-is (namespace rewrite only)

| Reference file | Jobomate location | Notes |
|---|---|---|
| `AvaloniaShell/Llm/ILlmAdapter.cs` | `Jobomate.App/Llm/ILlmAdapter.cs` | `ILlmAdapter`, `LlmEndpoint`, `LlmCallOptions` |
| `AvaloniaShell/Llm/LlmGateway.cs` | `Jobomate.App/Llm/LlmGateway.cs` | adapter routing, transient retry, fallback chain |
| `AvaloniaShell/Llm/LlmCapabilityRegistry.cs` | `Jobomate.App/Llm/` | |
| `AvaloniaShell/Llm/LlmCostLedger.cs` | `Jobomate.App/Llm/` | |
| `AvaloniaShell/Llm/LlmErrorNormalizer.cs` | `Jobomate.App/Llm/` | provider error → `AgentErrorCode` |
| `AvaloniaShell/Llm/LlmAdapterException.cs` | `Jobomate.App/Llm/` | |
| `AvaloniaShell/Llm/ModelErrorCode.cs` | `Jobomate.App/Llm/` | |
| `AvaloniaShell/Llm/ModelCapabilities.cs` | `Jobomate.App/Llm/` | `ProviderModelMetadata`, tool-calling tiers, vision detection |
| `AvaloniaShell/Llm/TransientRetry.cs` | `Jobomate.App/Llm/` | |
| `AvaloniaShell/Llm/{OpenAi,Anthropic,Google}StreamParser.cs` | `Jobomate.App/Llm/` | SSE streaming |
| `AvaloniaShell/Llm/Adapters/OpenAiCompatibleAdapter.cs` | `Jobomate.App/Llm/Adapters/` | serves OpenAI/OpenRouter/Mistral/Groq/DeepSeek/Together/xAI/LM Studio/Ollama |
| `AvaloniaShell/Llm/Adapters/AnthropicAdapter.cs` | `Jobomate.App/Llm/Adapters/` | |
| `AvaloniaShell/Llm/Adapters/GoogleAiAdapter.cs` | `Jobomate.App/Llm/Adapters/` | |
| `AvaloniaShell/Llm/Adapters/CliAdapter.cs` | `Jobomate.App/Llm/Adapters/` | |
| `AvaloniaShell/Persistence/ICredentialStore.cs` | `Jobomate.App/Persistence/` | (task 3) |
| `AvaloniaShell/Persistence/KeychainCredentialStore.cs` | `Jobomate.App/Persistence/` | service → `com.jobomate.credentials` (task 3) |
| `AvaloniaShell/Persistence/MacKeychain.cs` | `Jobomate.App/Persistence/` | Security.framework P/Invoke (task 3) |
| `AvaloniaShell/Observability/SecretRedactor.cs` | `Jobomate.App/Security/` | (task 3) |
| `AvaloniaShell/BundledLlamaServer.cs` | `Jobomate.App/Llm/Local/` | loopback GGUF server (task 4) |

## New Contracts shim (`Jobomate.App/Contracts/LlmContracts.cs`)

The ported gateway referenced four `MultiAgentOS.Contracts` types — reproduced here:
`LlmCapability` (flags), `AgentErrorCode`, `AppConnectionType`, `LlmCost`. Added the
provider defaults table (`AppApiProvider`, `Providers.Info`, `AdapterNames`) — the
concept extracted from `AppServices.ProviderInfo`.

## Reimplemented (modeled on reference, not copied)

- **`LocalLlmRuntime`** — Ollama (`127.0.0.1:11434`) / LM Studio (`127.0.0.1:1234/v1`) /
  generic OpenAI-compatible detection + GGUF filesystem scan. The reference
  `LocalLlmRuntimeIntegration.cs` was a partial of the god-object. (task 4)
- **`JobomateAuditLog`** — redacted audit rows (SQLite) + JSONL mirror, modeled on the
  reference's `FileAgentAuditLog`. (task 3)
- **`ObservableObject`** — tiny INotifyPropertyChanged base, same shape as the reference. (UI)
- **Approval surface** — event-driven, modeled on `Security/ProposalReviewHub.cs`. (task 9)

## Deliberately NOT ported (too entangled)

`AppServices.cs` (~202 KB god-object) and `MainWindow.axaml.cs` (~15 k lines) — Jobomate
builds a slim `JobomateServices` composition root and fresh UI instead.
