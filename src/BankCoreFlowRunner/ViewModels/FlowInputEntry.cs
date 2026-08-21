using BankCoreFlowRunner.Common;

namespace BankCoreFlowRunner.ViewModels;

public class FlowInputEntry : ObservableObjectBase
{
    private string _value;

    public FlowInputEntry(string variableName, string label, string defaultValue, bool secret)
    {
        VariableName = variableName;
        Label = label;
        Secret = secret;
        _value = defaultValue;
    }

    public string VariableName { get; }
    public string Label { get; }
    public bool Secret { get; }

    public string Value
    {
        get => _value;
        set => SetField(ref _value, value);
    }
}
