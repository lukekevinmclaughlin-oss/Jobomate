using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using Jobomate.Contracts;

namespace Jobomate.Llm;

// Capability-driven routing per llm-software-architecture/01:
// "the app asks 'is there a model with tool-calls + long context + local
// inference?'". Adapters register a default capability set; specific
// models can override (e.g. only certain DeepSeek models do reasoning).
//
// Phase 2 deliberately keeps this minimal: a tiny in-memory map keyed by
// (adapterName, modelId). Phase 11 retires the brand-keyed maps inside
// AppConnectionConfig.SupportsReasoningEffort and routes them through this
// registry.
public sealed class LlmCapabilityRegistry
{
    private readonly ConcurrentDictionary<string, LlmCapability> _adapterDefaults = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<(string Adapter, string Model), LlmCapability> _modelOverrides = new();

    public void RegisterAdapter(string adapter, LlmCapability defaults)
        => _adapterDefaults[adapter] = defaults;

    public void OverrideModel(string adapter, string model, LlmCapability capabilities)
        => _modelOverrides[(adapter, model)] = capabilities;

    public LlmCapability CapabilitiesFor(string adapter, string model)
    {
        if (_modelOverrides.TryGetValue((adapter, model), out var ovr)) return ovr;
        return _adapterDefaults.TryGetValue(adapter, out var def) ? def : LlmCapability.None;
    }

    public IReadOnlyDictionary<string, LlmCapability> Defaults => _adapterDefaults;
}
