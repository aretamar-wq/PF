using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using BankCoreFlowRunner.Models;

namespace BankCoreFlowRunner.Services;

public class FlowEngine
{
    private readonly HttpClient _httpClient;

    public FlowEngine(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task RunAsync(
        Profile profile,
        FlowDefinition flow,
        IReadOnlyDictionary<string, string> inputValues,
        ObservableCollection<StepLogEntry> log,
        CancellationToken ct)
    {
        var variables = new Dictionary<string, string>(inputValues);

        foreach (var step in flow.Steps)
        {
            ct.ThrowIfCancellationRequested();

            var entry = new StepLogEntry { Name = step.Name, Status = StepStatus.Running };
            log.Add(entry);

            var stopwatch = Stopwatch.StartNew();
            try
            {
                await ExecuteStepAsync(profile, step, variables, entry, ct);
            }
            catch (OperationCanceledException)
            {
                entry.Status = StepStatus.Error;
                entry.ErrorMessage = "Cancelado.";
                break;
            }
            catch (Exception ex)
            {
                entry.Status = StepStatus.Error;
                entry.ErrorMessage = ex.Message;
                break;
            }
            finally
            {
                entry.DurationMs = stopwatch.ElapsedMilliseconds;
            }

            if (entry.Status == StepStatus.Error)
            {
                break;
            }
        }
    }

    private async Task ExecuteStepAsync(
        Profile profile,
        FlowStep step,
        Dictionary<string, string> variables,
        StepLogEntry entry,
        CancellationToken ct)
    {
        var path = VariableSubstitution.Substitute(step.PathTemplate, variables);
        var url = CombineUrl(profile.BaseUrl, path);

        using var request = new HttpRequestMessage(new HttpMethod(step.Method), url);
        ApplyAuth(request, profile);

        foreach (var header in step.Headers)
        {
            if (string.Equals(header.Key, "Content-Type", StringComparison.OrdinalIgnoreCase))
            {
                continue; // Se aplica junto con el content, no como header suelto.
            }
            request.Headers.TryAddWithoutValidation(header.Key, VariableSubstitution.Substitute(header.Value, variables));
        }

        if (!string.IsNullOrEmpty(step.BodyTemplate))
        {
            var body = VariableSubstitution.Substitute(step.BodyTemplate, variables);
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        }

        entry.RequestSummary = $"{step.Method} {url}";

        using var response = await _httpClient.SendAsync(request, ct);
        var responseBody = await response.Content.ReadAsStringAsync(ct);

        entry.HttpStatusCode = (int)response.StatusCode;
        entry.ResponseSummary = Truncate(responseBody, 800);

        if ((int)response.StatusCode != step.ExpectedStatusCode)
        {
            entry.Status = StepStatus.Error;
            entry.ErrorMessage = $"Se esperaba HTTP {step.ExpectedStatusCode} y se recibió HTTP {(int)response.StatusCode}.";
            return;
        }

        if (step.ExtractVariables.Count > 0 && !string.IsNullOrWhiteSpace(responseBody))
        {
            using var document = JsonDocument.Parse(responseBody);
            foreach (var (variableName, jsonPath) in step.ExtractVariables)
            {
                var extracted = JsonPathExtractor.Extract(document.RootElement, jsonPath);
                if (extracted is not null)
                {
                    variables[variableName] = extracted;
                }
            }
        }

        entry.Status = StepStatus.Success;
    }

    private static void ApplyAuth(HttpRequestMessage request, Profile profile)
    {
        switch (profile.AuthType)
        {
            case AuthType.ApiKey:
                request.Headers.TryAddWithoutValidation(profile.ApiKeyHeaderName, profile.ApiKeyOrToken);
                break;
            case AuthType.Bearer:
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", profile.ApiKeyOrToken);
                break;
            case AuthType.None:
            default:
                break;
        }
    }

    private static string CombineUrl(string baseUrl, string path)
        => baseUrl.TrimEnd('/') + "/" + path.TrimStart('/');

    private static string Truncate(string value, int maxLength)
        => value.Length <= maxLength ? value : value[..maxLength] + "...";
}
