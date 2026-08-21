using System.Windows;
using BankCoreFlowRunner.Models;
using BankCoreFlowRunner.ViewModels;

namespace BankCoreFlowRunner;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();

        var viewModel = new MainViewModel
        {
            RequestProfileEdit = ShowProfileDialog
        };
        DataContext = viewModel;
    }

    private Profile? ShowProfileDialog(Profile? existing)
    {
        var dialog = new ProfileDialog(existing?.Clone() ?? new Profile())
        {
            Owner = this
        };

        return dialog.ShowDialog() == true ? dialog.EditedProfile : null;
    }
}
