using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using XqzProbe;

const string Description = """
    Probe the control channel of the Sony XQZ-IV01 Vlog Monitor (Windows / WinUSB).

    The monitor is a USB-C DisplayPort Alt-Mode sink plus a small vendor USB
    device (VID:PID 054c:0e48). The camera apps talk to the vendor device over a
    bulk OUT/IN pair on interface 0 with raw ASCII commands:

        phone -> monitor : "show"  (enables the DP sink + panel; 1.000 s watchdog)
                           "stop"  (drops the DP link / blanks the panel)
        monitor -> phone : "disp_on" / "disp_off"  (ACKs, ignored by Sony's apps)
                           "flip"                 (FLIP button pressed)

    The monitor does not appear as a DisplayPort sink until "show" is sent;
    refreshing it every 400 ms keeps HPD asserted. Video still travels over DP Alt
    Mode, so a USB-only port shows the control device but no display.

    Only the control device (054c:0e48) is touched; the USB Audio Class device
    (054c:0e49) that appears with "show" active and a mic plugged is not handled.

    Requirements:
      The control device must be bound to the WinUSB driver (e.g. via Zadig).

    Usage:
      xqz_probe                   dump descriptors, heartbeat, print RX
      xqz_probe --duration 10     run for 10 s, send "stop", exit
      xqz_probe --no-show         only dump descriptors and listen
      xqz_probe --interface 1     override interface index

    Options:
      --vid <id>        vendor ID (default 0x054c)
      --pid <id>        product ID (default 0x0e48)
      --interface <n>   interface index (default: auto, prefer 0)
      --interval <s>    seconds between "show" heartbeats (default 0.4)
      --no-show         do not send "show"; just dump descriptors and read
      --duration <s>    run for N seconds, then send "stop" and exit (0 = forever)
      --guid <guid>     extra device interface GUID to search (e.g. from Zadig)
      -h, --help        show this help

    Press Ctrl-C to send "stop" and exit.
    """;

ushort vendorId = 0x054C;
ushort productId = 0x0E48;
byte? interfaceNumber = null;
var interval = 0.4;
var noShow = false;
var duration = 0.0;
var interfaceGuids = new List<Guid> { WinUSBDevice.GUID_DEVINTERFACE_USB_DEVICE };

try
{
    for (var index = 0; index < args.Length; index++)
    {
        string Next() =>
            ++index < args.Length ? args[index] : throw new ArgumentException($"{args[index - 1]} requires a value");

        switch (args[index])
        {
            case "-h":
            case "--help":
                Console.WriteLine(Description);
                return 0;
            case "--vid":
                vendorId = (ushort)ParseInteger(Next());
                break;
            case "--pid":
                productId = (ushort)ParseInteger(Next());
                break;
            case "--interface":
                interfaceNumber = (byte)ParseInteger(Next());
                break;
            case "--interval":
                interval = double.Parse(Next(), CultureInfo.InvariantCulture);
                break;
            case "--no-show":
                noShow = true;
                break;
            case "--duration":
                duration = double.Parse(Next(), CultureInfo.InvariantCulture);
                break;
            case "--guid":
                interfaceGuids.Add(Guid.Parse(Next()));
                break;
            default:
                throw new ArgumentException($"unrecognized argument: {args[index]}");
        }
    }
}
catch (Exception exception) when (exception is ArgumentException or FormatException or OverflowException)
{
    Console.Error.WriteLine($"error: {exception.Message}");
    Console.Error.WriteLine("run with --help for usage");

    return 2;
}

using var device = WinUSBDevice.Open(vendorId, productId, interfaceGuids, Console.Error);

if (device is null)
{
    Console.Error.WriteLine(
        $"device {HexId(vendorId)}:{HexId(productId)} not found "
            + "(is the monitor connected and bound to WinUSB, e.g. via Zadig?)"
    );

    return 1;
}

var configuration = DumpDevice(device);

var candidates = interfaceNumber is { } requested
    ? configuration.Interfaces.Where(i => i.Number == requested && i.AlternateSetting == 0)
    : configuration.Interfaces;

(USBInterface Interface, USBEndpoint In, USBEndpoint Out)? chosen = null;

foreach (var candidate in candidates)
{
    var (epIn, epOut) = candidate.FindBulkPair();

    if (epIn is not null && epOut is not null)
    {
        chosen = (candidate, epIn, epOut);
        break;
    }
}

if (chosen is not { } selection)
{
    Console.Error.WriteLine("no interface with a bulk IN/OUT pair found; run with --interface to try a specific one");

    return 1;
}

var (usbInterface, endpointIn, endpointOut) = selection;

Console.WriteLine();
Console.WriteLine(
    $"using interface {usbInterface.Number} "
        + $"(bulk OUT {HexId(endpointOut.Address)}, bulk IN {HexId(endpointIn.Address)})"
);

IntPtr handle;

try
{
    handle = device.GetInterfaceHandle(usbInterface.Number);

    if (usbInterface.AlternateSetting != 0)
    {
        WinUSBDevice.SetAlternateSetting(handle, usbInterface.AlternateSetting);
    }

    WinUSBDevice.SetPipeTimeout(handle, endpointIn.Address, 200);
    WinUSBDevice.SetPipeTimeout(handle, endpointOut.Address, 50);
}
catch (Exception exception) when (exception is Win32Exception or InvalidOperationException)
{
    Console.Error.WriteLine(exception.Message);

    return 1;
}

using var stop = new CancellationTokenSource();
using var interrupted = new ManualResetEventSlim();
var stopwatch = Stopwatch.StartNew();

Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    interrupted.Set();
};

bool Expired() => duration > 0 && stopwatch.Elapsed.TotalSeconds >= duration;

var reader = new Thread(() =>
{
    var buffer = new byte[endpointIn.MaxPacketSize > 0 ? endpointIn.MaxPacketSize : 64];

    while (!stop.IsCancellationRequested)
    {
        int? length;

        try
        {
            length = WinUSBDevice.Read(handle, endpointIn.Address, buffer);
        }
        catch (Win32Exception exception)
        {
            if (!stop.IsCancellationRequested)
            {
                Console.WriteLine($"RX error: {exception.Message}");
            }

            return;
        }

        if (length is not { } count)
        {
            continue;
        }

        var raw = buffer.AsSpan(0, count);
        var text = Encoding.UTF8.GetString(raw).Trim();

        Console.WriteLine(
            $"[{stopwatch.Elapsed.TotalSeconds,6:F2}s] RX {FormatBytes(raw)}  ->  {Quote(text)}"
        );

        foreach (var line in text.Replace('\r', '\n').Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (line == "flip")
            {
                Console.WriteLine("   [FLIP button pressed]");
            }
        }
    }
})
{
    IsBackground = true,
    Name = "RX",
};

reader.Start();

try
{
    var tick = noShow ? TimeSpan.FromSeconds(0.1) : TimeSpan.FromSeconds(interval);

    if (noShow)
    {
        Console.WriteLine("listening; Ctrl-C to exit");
    }
    else
    {
        Console.WriteLine($"sending 'show' every {interval.ToString(CultureInfo.InvariantCulture)}s; Ctrl-C to send 'stop'");
    }

    while (!Expired() && !interrupted.IsSet)
    {
        if (!noShow)
        {
            WinUSBDevice.Write(handle, endpointOut.Address, "show"u8);
        }

        interrupted.Wait(tick);
    }

    if (interrupted.IsSet)
    {
        Console.WriteLine();
        Console.WriteLine("interrupted");
    }
    else if (duration > 0)
    {
        Console.WriteLine($"duration reached ({duration.ToString(CultureInfo.InvariantCulture)}s)");
    }
}
catch (Win32Exception exception)
{
    Console.Error.WriteLine($"TX error: {exception.Message}");
}
finally
{
    try
    {
        Console.WriteLine("TX b'stop'");
        WinUSBDevice.Write(handle, endpointOut.Address, "stop"u8);
        Thread.Sleep(300);
    }
    catch (Win32Exception) { }

    stop.Cancel();
    WinUSBDevice.Abort(handle, endpointIn.Address);
    reader.Join(TimeSpan.FromSeconds(1));
}

return 0;

static long ParseInteger(string value)
{
    value = value.Trim();

    if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
    {
        return long.Parse(value.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
    }

    return long.Parse(value, NumberStyles.Integer, CultureInfo.InvariantCulture);
}

static string HexId(int value) => $"0x{value:x4}";

static string FormatBytes(ReadOnlySpan<byte> data)
{
    var builder = new StringBuilder("b'");

    foreach (var value in data)
    {
        builder.Append(
            value switch
            {
                (byte)'\\' => "\\\\",
                (byte)'\'' => "\\'",
                (byte)'\r' => "\\r",
                (byte)'\n' => "\\n",
                (byte)'\t' => "\\t",
                >= 0x20 and < 0x7F => ((char)value).ToString(),
                _ => $"\\x{value:x2}",
            }
        );
    }

    return builder.Append('\'').ToString();
}

static string Quote(string text) => $"'{text.Replace("\\", "\\\\").Replace("'", "\\'")}'";

static USBConfiguration DumpDevice(WinUSBDevice device)
{
    var descriptor = device.GetDeviceDescriptor();
    var vendorId = descriptor[8] | (descriptor[9] << 8);
    var productId = descriptor[10] | (descriptor[11] << 8);

    Console.WriteLine($"device {HexId(vendorId)}:{HexId(productId)} path={device.Path}");
    Console.WriteLine($"  manufacturer: {device.GetString(descriptor[14])}");
    Console.WriteLine($"  product     : {device.GetString(descriptor[15])}");
    Console.WriteLine($"  serial      : {device.GetString(descriptor[16])}");

    var configuration = device.GetConfiguration();

    Console.WriteLine($"  config {configuration.Value}: {configuration.NumInterfaces} interface(s)");

    foreach (var usbInterface in configuration.Interfaces)
    {
        Console.WriteLine(
            $"    interface {usbInterface.Number} alt={usbInterface.AlternateSetting} "
                + $"class=0x{usbInterface.Class:x2}/0x{usbInterface.SubClass:x2}/0x{usbInterface.Protocol:x2}"
        );

        foreach (var endpoint in usbInterface.Endpoints)
        {
            Console.WriteLine(
                $"      endpoint {HexId(endpoint.Address)} {(endpoint.IsIn ? "IN" : "OUT"),-3} "
                    + $"{endpoint.TypeName,-11} maxPacket={endpoint.MaxPacketSize}"
            );
        }
    }

    return configuration;
}
