namespace BankCoreFlowRunner.Models;

public class FlowInputDefinition
{
    public string VariableName { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string? DefaultValue { get; set; }
    public bool Secret { get; set; }
}
