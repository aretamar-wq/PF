using System.Collections.ObjectModel;
using System.IO;
using System.Net.Http;
using System.Threading;
using BankCoreFlowRunner.Common;
using BankCoreFlowRunner.Models;
using BankCoreFlowRunner.Services;

namespace BankCoreFlowRunner.ViewModels;

public class MainViewModel : ObservableObjectBase
{
    private readonly ProfileStore _profileStore = new();
    private readonly FlowStore _flowStore = new();
    private readonly FlowEngine _flowEngine;
    private readonly HttpClient _httpClient;

    private Profile? _selectedProfile;
    private FlowDefinition? _selectedFlow;
    private bool _isRunning;
    private string _statusMessage = "Listo.";

    public ObservableCollection<Profile> Profiles { get; } = new();
    public ObservableCollection<FlowDefinition> Flows { get; } = new();
    public ObservableCollection<FlowInputEntry> CurrentInputs { get; } = new();
    public ObservableCollection<StepLogEntry> Log { get; } = new();

    public Profile? SelectedProfile
    {
        get => _selectedProfile;
        set => SetField(ref _selectedProfile, value);
    }

    public FlowDefinition? SelectedFlow
    {
        get => _selectedFlow;
        set
        {
            if (SetField(ref _selectedFlow, value))
            {
                RebuildInputs();
            }
        }
    }

    public bool IsRunning
    {
        get => _isRunning;
        set => SetField(ref _isRunning, value);
    }

    public string StatusMessage
    {
        get => _statusMessage;
        set => SetField(ref _statusMessage, value);
    }

    /// <summary>Lo asigna la vista para abrir el diálogo de edición de perfiles sin acoplar el ViewModel a WPF.</summary>
    public Func<Profile?, Profile?>? RequestProfileEdit { get; set; }

    public RelayCommand ReloadFlowsCommand { get; }
    public RelayCommand AddProfileCommand { get; }
    public RelayCommand EditProfileCommand { get; }
    public RelayCommand DeleteProfileCommand { get; }
    public AsyncRelayCommand RunFlowCommand { get; }
    public RelayCommand SaveLogCommand { get; }

    public MainViewModel()
    {
        _httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        _flowEngine = new FlowEngine(_httpClient);

        ReloadFlowsCommand = new RelayCommand(_ => ReloadFlows());
        AddProfileCommand = new RelayCommand(_ => AddProfile());
        EditProfileCommand = new RelayCommand(_ => EditProfile(), _ => SelectedProfile is not null);
        DeleteProfileCommand = new RelayCommand(_ => DeleteProfile(), _ => SelectedProfile is not null);
        RunFlowCommand = new AsyncRelayCommand(RunSelectedFlowAsync, () => SelectedFlow is not null && SelectedProfile is not null && !IsRunning);
        SaveLogCommand = new RelayCommand(_ => SaveLog(), _ => Log.Count > 0);

        LoadProfiles();
        ReloadFlows();
    }

    private void LoadProfiles()
    {
        Profiles.Clear();
        foreach (var profile in _profileStore.Load())
        {
            Profiles.Add(profile);
        }

        SelectedProfile = Profiles.FirstOrDefault();
    }

    private void ReloadFlows()
    {
        Flows.Clear();
        var flows = _flowStore.LoadAll(out var errors);
        foreach (var flow in flows)
        {
            Flows.Add(flow);
        }

        SelectedFlow = Flows.FirstOrDefault();

        StatusMessage = errors.Count == 0
            ? $"{flows.Count} flow(s) cargado(s)."
            : $"{flows.Count} flow(s) cargado(s). Errores: {string.Join(" | ", errors)}";
    }

    private void RebuildInputs()
    {
        CurrentInputs.Clear();
        if (SelectedFlow is null) return;

        foreach (var input in SelectedFlow.Inputs)
        {
            CurrentInputs.Add(new FlowInputEntry(input.VariableName, input.Label, input.DefaultValue ?? string.Empty, input.Secret));
        }
    }

    private void AddProfile()
    {
        var created = RequestProfileEdit?.Invoke(null);
        if (created is null) return;

        Profiles.Add(created);
        SelectedProfile = created;
        _profileStore.Save(Profiles);
    }

    private void EditProfile()
    {
        if (SelectedProfile is null) return;

        var edited = RequestProfileEdit?.Invoke(SelectedProfile);
        if (edited is null) return;

        var index = Profiles.IndexOf(SelectedProfile);
        Profiles[index] = edited;
        SelectedProfile = edited;
        _profileStore.Save(Profiles);
    }

    private void DeleteProfile()
    {
        if (SelectedProfile is null) return;

        Profiles.Remove(SelectedProfile);
        SelectedProfile = Profiles.FirstOrDefault();
        _profileStore.Save(Profiles);
    }

    private async Task RunSelectedFlowAsync()
    {
        if (SelectedFlow is null || SelectedProfile is null) return;

        IsRunning = true;
        Log.Clear();
        StatusMessage = $"Ejecutando '{SelectedFlow.Name}'...";

        var inputValues = CurrentInputs.ToDictionary(i => i.VariableName, i => i.Value);

        try
        {
            await _flowEngine.RunAsync(SelectedProfile, SelectedFlow, inputValues, Log, CancellationToken.None);
            var hasError = Log.Any(l => l.Status == StepStatus.Error);
            StatusMessage = hasError ? "El flow terminó con errores." : "El flow se ejecutó correctamente.";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Error inesperado: {ex.Message}";
        }
        finally
        {
            IsRunning = false;
        }
    }

    private void SaveLog()
    {
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Filter = "Archivo de texto (*.txt)|*.txt|Todos los archivos (*.*)|*.*",
            FileName = $"flow-log-{DateTime.Now:yyyyMMdd-HHmmss}.txt"
        };

        if (dialog.ShowDialog() != true) return;

        using var writer = new StreamWriter(dialog.FileName);
        foreach (var entry in Log)
        {
            writer.WriteLine($"[{entry.Status}] {entry.Name} ({entry.DurationMs} ms)");
            writer.WriteLine($"  Request : {entry.RequestSummary}");
            writer.WriteLine($"  Response: HTTP {entry.HttpStatusCode} - {entry.ResponseSummary}");
            if (!string.IsNullOrEmpty(entry.ErrorMessage))
            {
                writer.WriteLine($"  Error   : {entry.ErrorMessage}");
            }
            writer.WriteLine();
        }
    }
}
