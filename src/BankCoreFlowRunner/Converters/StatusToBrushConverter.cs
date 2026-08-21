using System.Globalization;
using System.Windows.Data;
using System.Windows.Media;
using BankCoreFlowRunner.Models;

namespace BankCoreFlowRunner.Converters;

public class StatusToBrushConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        return value switch
        {
            StepStatus.Success => Brushes.SeaGreen,
            StepStatus.Error => Brushes.IndianRed,
            StepStatus.Running => Brushes.DarkOrange,
            _ => Brushes.Gray
        };
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}
