namespace BankCoreFlowRunner.Models;

public class FlowStep
{
    public string Name { get; set; } = string.Empty;
    public string Method { get; set; } = "GET";
    public string PathTemplate { get; set; } = string.Empty;
    public Dictionary<string, string> Headers { get; set; } = new();

    /// <summary>Cuerpo con placeholders {{variable}}. Null/omitido para requests sin body.</summary>
    public string? BodyTemplate { get; set; }

    /// <summary>Content-Type del body. Por defecto JSON; usar "application/x-www-form-urlencoded" para form-encoded.</summary>
    public string BodyContentType { get; set; } = "application/json";

    /// <summary>Mapa variable -> path dentro de la respuesta JSON (ej: "data.account.balance" o "items[0].id").</summary>
    public Dictionary<string, string> ExtractVariables { get; set; } = new();

    public int ExpectedStatusCode { get; set; } = 200;
}
