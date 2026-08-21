using System.Text.RegularExpressions;

namespace BankCoreFlowRunner.Services;

public static class VariableSubstitution
{
    private static readonly Regex TokenRegex = new(@"\{\{\s*(\w+)\s*\}\}", RegexOptions.Compiled);

    public static string Substitute(string? template, IReadOnlyDictionary<string, string> variables)
    {
        if (string.IsNullOrEmpty(template)) return template ?? string.Empty;

        return TokenRegex.Replace(template, match =>
        {
            var key = match.Groups[1].Value;
            return variables.TryGetValue(key, out var value) ? value : match.Value;
        });
    }
}
