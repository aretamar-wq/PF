using System.Text.Json.Serialization;

namespace BankCoreFlowRunner.Models;

public enum AuthType
{
    None,
    ApiKey,
    Bearer,
    OAuth2ClientCredentials
}

public class Profile
{
    public string Name { get; set; } = "Nuevo perfil";
    public string BaseUrl { get; set; } = "https://";
    public AuthType AuthType { get; set; } = AuthType.Bearer;

    public string ApiKeyHeaderName { get; set; } = "X-Api-Key";

    /// <summary>Valor del header (AuthType.ApiKey) o del Bearer estático (AuthType.Bearer).</summary>
    public string ApiKeyOrToken { get; set; } = string.Empty;

    /// <summary>Endpoint OAuth2 de client_credentials (ej: https://host/ibsapi/Token). Solo AuthType.OAuth2ClientCredentials.</summary>
    public string TokenUrl { get; set; } = string.Empty;
    public string ClientId { get; set; } = string.Empty;
    public string ClientSecret { get; set; } = string.Empty;

    /// <summary>Token obtenido dinámicamente; nunca se persiste en disco.</summary>
    [JsonIgnore]
    public string? CachedAccessToken { get; set; }

    [JsonIgnore]
    public DateTime CachedAccessTokenExpiresAtUtc { get; set; }

    public Profile Clone() => new()
    {
        Name = Name,
        BaseUrl = BaseUrl,
        AuthType = AuthType,
        ApiKeyHeaderName = ApiKeyHeaderName,
        ApiKeyOrToken = ApiKeyOrToken,
        TokenUrl = TokenUrl,
        ClientId = ClientId,
        ClientSecret = ClientSecret
    };

    public override string ToString() => Name;
}
