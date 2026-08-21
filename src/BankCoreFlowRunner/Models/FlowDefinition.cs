using System.Text.Json.Serialization;

namespace BankCoreFlowRunner.Models;

public class FlowDefinition
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public List<FlowInputDefinition> Inputs { get; set; } = new();
    public List<FlowStep> Steps { get; set; } = new();

    [JsonIgnore]
    public string? SourceFile { get; set; }

    public override string ToString() => Name;
}
