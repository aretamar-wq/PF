using System.IO;
using System.Text.Json;
using BankCoreFlowRunner.Models;

namespace BankCoreFlowRunner.Services;

public class FlowStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly string _flowsDirectory;

    public FlowStore(string? directory = null)
    {
        _flowsDirectory = directory ?? Path.Combine(AppContext.BaseDirectory, "Flows");
    }

    public List<FlowDefinition> LoadAll(out List<string> errors)
    {
        errors = new List<string>();
        var flows = new List<FlowDefinition>();

        if (!Directory.Exists(_flowsDirectory))
        {
            return flows;
        }

        foreach (var file in Directory.EnumerateFiles(_flowsDirectory, "*.json").OrderBy(f => f))
        {
            try
            {
                var json = File.ReadAllText(file);
                var flow = JsonSerializer.Deserialize<FlowDefinition>(json, JsonOptions);
                if (flow is not null)
                {
                    flow.SourceFile = file;
                    flows.Add(flow);
                }
            }
            catch (JsonException ex)
            {
                errors.Add($"{Path.GetFileName(file)}: {ex.Message}");
            }
        }

        return flows;
    }
}
