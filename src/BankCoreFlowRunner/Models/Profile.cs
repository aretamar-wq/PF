namespace BankCoreFlowRunner.Models;

public enum AuthType
{
    None,
    ApiKey,
    Bearer
}

public class Profile
{
    public string Name { get; set; } = "Nuevo perfil";
    public string BaseUrl { get; set; } = "https://";
    public AuthType AuthType { get; set; } = AuthType.Bearer;
    public string ApiKeyHeaderName { get; set; } = "X-Api-Key";
    public string ApiKeyOrToken { get; set; } = string.Empty;

    public Profile Clone() => new()
    {
        Name = Name,
        BaseUrl = BaseUrl,
        AuthType = AuthType,
        ApiKeyHeaderName = ApiKeyHeaderName,
        ApiKeyOrToken = ApiKeyOrToken
    };

    public override string ToString() => Name;
}
