using System.Text.Json;
using System.Text.RegularExpressions;

namespace BankCoreFlowRunner.Services;

/// <summary>
/// Navegación simple de JSON por notación de puntos con índices de array opcionales,
/// ej: "data.accounts[0].balance". No es JSONPath completo, alcanza para mapear
/// respuestas típicas de APIs REST de un core bancario.
/// </summary>
public static class JsonPathExtractor
{
    private static readonly Regex SegmentRegex = new(@"^([^\[\]]+)(\[(\d+)\])?$", RegexOptions.Compiled);

    public static string? Extract(JsonElement root, string path)
    {
        var current = root;

        foreach (var rawSegment in path.Split('.'))
        {
            var match = SegmentRegex.Match(rawSegment);
            if (!match.Success) return null;

            var propertyName = match.Groups[1].Value;
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(propertyName, out var next))
            {
                return null;
            }
            current = next;

            if (match.Groups[2].Success)
            {
                var index = int.Parse(match.Groups[3].Value);
                if (current.ValueKind != JsonValueKind.Array || index >= current.GetArrayLength())
                {
                    return null;
                }
                current = current.EnumerateArray().ElementAt(index);
            }
        }

        return current.ValueKind switch
        {
            JsonValueKind.String => current.GetString(),
            JsonValueKind.Number => current.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Null => null,
            _ => current.GetRawText()
        };
    }
}
