using System.IO;
using System.Text.Json;
using BankCoreFlowRunner.Models;

namespace BankCoreFlowRunner.Services;

public class ProfileStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
    };

    private readonly string _filePath;

    public ProfileStore(string? directory = null)
    {
        var baseDir = directory ?? AppContext.BaseDirectory;
        _filePath = Path.Combine(baseDir, "profiles.local.json");
    }

    public List<Profile> Load()
    {
        if (!File.Exists(_filePath))
        {
            return new List<Profile>();
        }

        var json = File.ReadAllText(_filePath);
        if (string.IsNullOrWhiteSpace(json)) return new List<Profile>();

        return JsonSerializer.Deserialize<List<Profile>>(json, JsonOptions) ?? new List<Profile>();
    }

    public void Save(IEnumerable<Profile> profiles)
    {
        var json = JsonSerializer.Serialize(profiles.ToList(), JsonOptions);
        File.WriteAllText(_filePath, json);
    }
}
