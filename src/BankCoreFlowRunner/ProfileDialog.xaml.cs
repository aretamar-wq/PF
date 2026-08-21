using System.Windows;
using BankCoreFlowRunner.Models;

namespace BankCoreFlowRunner;

public partial class ProfileDialog : Window
{
    public Profile EditedProfile { get; }

    public ProfileDialog(Profile profile)
    {
        InitializeComponent();

        EditedProfile = profile;
        DataContext = EditedProfile;

        AuthTypeCombo.ItemsSource = Enum.GetValues(typeof(AuthType));
        TokenBox.Password = EditedProfile.ApiKeyOrToken;
    }

    private void OnAccept(object sender, RoutedEventArgs e)
    {
        EditedProfile.ApiKeyOrToken = TokenBox.Password;

        if (string.IsNullOrWhiteSpace(EditedProfile.Name) || string.IsNullOrWhiteSpace(EditedProfile.BaseUrl))
        {
            MessageBox.Show(this, "Nombre y URL base son obligatorios.", "Datos incompletos",
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        DialogResult = true;
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
    }
}
