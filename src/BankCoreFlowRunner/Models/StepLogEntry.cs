using BankCoreFlowRunner.Common;

namespace BankCoreFlowRunner.Models;

public enum StepStatus
{
    Pending,
    Running,
    Success,
    Error
}

public class StepLogEntry : ObservableObjectBase
{
    private StepStatus _status = StepStatus.Pending;
    private string? _requestSummary;
    private string? _responseSummary;
    private string? _errorMessage;
    private int? _httpStatusCode;
    private long _durationMs;

    public string Name { get; set; } = string.Empty;

    public string? RequestSummary
    {
        get => _requestSummary;
        set => SetField(ref _requestSummary, value);
    }

    public StepStatus Status
    {
        get => _status;
        set => SetField(ref _status, value);
    }

    public string? ResponseSummary
    {
        get => _responseSummary;
        set => SetField(ref _responseSummary, value);
    }

    public string? ErrorMessage
    {
        get => _errorMessage;
        set => SetField(ref _errorMessage, value);
    }

    public int? HttpStatusCode
    {
        get => _httpStatusCode;
        set => SetField(ref _httpStatusCode, value);
    }

    public long DurationMs
    {
        get => _durationMs;
        set => SetField(ref _durationMs, value);
    }
}
