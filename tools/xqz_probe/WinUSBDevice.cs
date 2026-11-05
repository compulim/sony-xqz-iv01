using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using static XqzProbe.NativeMethods;

namespace XqzProbe;

internal sealed class WinUSBDevice : IDisposable
{
    // GUID_DEVINTERFACE_USB_DEVICE: registered by the hub driver for every USB device node.
    public static readonly Guid GUID_DEVINTERFACE_USB_DEVICE = new("A5DCBF10-6530-11D2-901F-00C04FB951ED");

    private readonly SafeFileHandle _file;
    private readonly IntPtr _rootHandle;
    private readonly List<IntPtr> _associatedHandles = [];

    private WinUSBDevice(string path, SafeFileHandle file, IntPtr rootHandle)
    {
        Path = path;
        _file = file;
        _rootHandle = rootHandle;
    }

    public string Path { get; }

    public static IEnumerable<string> EnumerateDevicePaths(Guid interfaceGuid)
    {
        var deviceInfoSet = SetupDiGetClassDevs(
            interfaceGuid,
            IntPtr.Zero,
            IntPtr.Zero,
            DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
        );

        if (deviceInfoSet == INVALID_HANDLE_VALUE)
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "SetupDiGetClassDevs failed");
        }

        var paths = new List<string>();

        try
        {
            for (uint index = 0; ; index++)
            {
                var interfaceData = new SP_DEVICE_INTERFACE_DATA
                {
                    cbSize = (uint)Marshal.SizeOf<SP_DEVICE_INTERFACE_DATA>(),
                };

                if (!SetupDiEnumDeviceInterfaces(deviceInfoSet, IntPtr.Zero, interfaceGuid, index, ref interfaceData))
                {
                    var error = Marshal.GetLastPInvokeError();

                    if (error == ERROR_NO_MORE_ITEMS)
                    {
                        break;
                    }

                    throw new Win32Exception(error, "SetupDiEnumDeviceInterfaces failed");
                }

                SetupDiGetDeviceInterfaceDetail(deviceInfoSet, ref interfaceData, IntPtr.Zero, 0, out var size, IntPtr.Zero);

                if (size == 0)
                {
                    continue;
                }

                var buffer = Marshal.AllocHGlobal((int)size);

                try
                {
                    // SP_DEVICE_INTERFACE_DETAIL_DATA_W.cbSize is 8 on 64-bit and 6 on 32-bit.
                    Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 8 : 6);

                    if (SetupDiGetDeviceInterfaceDetail(deviceInfoSet, ref interfaceData, buffer, size, out _, IntPtr.Zero))
                    {
                        var path = Marshal.PtrToStringUni(buffer + 4);

                        if (!string.IsNullOrEmpty(path))
                        {
                            paths.Add(path);
                        }
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(deviceInfoSet);
        }

        return paths;
    }

    public static WinUSBDevice? Open(ushort vendorId, ushort productId, IEnumerable<Guid> interfaceGuids, TextWriter log)
    {
        var needle = $"vid_{vendorId:x4}&pid_{productId:x4}";

        foreach (var guid in interfaceGuids)
        {
            foreach (var path in EnumerateDevicePaths(guid))
            {
                if (!path.Contains(needle, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var file = CreateFile(
                    path,
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    IntPtr.Zero,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
                    IntPtr.Zero
                );

                if (file.IsInvalid)
                {
                    log.WriteLine($"cannot open {path}: {new Win32Exception(Marshal.GetLastPInvokeError()).Message}");
                    file.Dispose();

                    continue;
                }

                if (!WinUsb_Initialize(file, out var handle))
                {
                    log.WriteLine(
                        $"WinUsb_Initialize failed on {path}: {new Win32Exception(Marshal.GetLastPInvokeError()).Message}"
                    );
                    file.Dispose();

                    continue;
                }

                return new WinUSBDevice(path, file, handle);
            }
        }

        return null;
    }

    public unsafe byte[] GetDescriptor(byte type, byte index, ushort languageId, int length)
    {
        var buffer = new byte[length];

        fixed (byte* pointer = buffer)
        {
            if (!WinUsb_GetDescriptor(_rootHandle, type, index, languageId, pointer, (uint)length, out var transferred))
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError(), "WinUsb_GetDescriptor failed");
            }

            return buffer[..(int)transferred];
        }
    }

    public byte[] GetDeviceDescriptor() => GetDescriptor(USB_DEVICE_DESCRIPTOR_TYPE, 0, 0, 18);

    public USBConfiguration GetConfiguration()
    {
        var header = GetDescriptor(USB_CONFIGURATION_DESCRIPTOR_TYPE, 0, 0, 9);

        if (header.Length < 4)
        {
            throw new InvalidDataException("short configuration descriptor");
        }

        var totalLength = header[2] | (header[3] << 8);

        return USBConfiguration.Parse(GetDescriptor(USB_CONFIGURATION_DESCRIPTOR_TYPE, 0, 0, totalLength));
    }

    public string? GetString(byte index)
    {
        if (index == 0)
        {
            return null;
        }

        try
        {
            var data = GetDescriptor(USB_STRING_DESCRIPTOR_TYPE, index, 0x0409, 255);

            if (data.Length < 2)
            {
                return null;
            }

            return Encoding.Unicode.GetString(data, 2, Math.Min(data[0], data.Length) - 2);
        }
        catch (Win32Exception)
        {
            return null;
        }
    }

    public IntPtr GetInterfaceHandle(byte interfaceNumber)
    {
        if (QueryInterfaceNumber(_rootHandle) == interfaceNumber)
        {
            return _rootHandle;
        }

        for (byte index = 0; index < byte.MaxValue; index++)
        {
            if (!WinUsb_GetAssociatedInterface(_rootHandle, index, out var handle))
            {
                break;
            }

            if (QueryInterfaceNumber(handle) == interfaceNumber)
            {
                _associatedHandles.Add(handle);

                return handle;
            }

            WinUsb_Free(handle);
        }

        throw new InvalidOperationException($"interface {interfaceNumber} is not accessible through WinUSB");
    }

    public static void SetAlternateSetting(IntPtr handle, byte setting)
    {
        if (!WinUsb_SetCurrentAlternateSetting(handle, setting))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "WinUsb_SetCurrentAlternateSetting failed");
        }
    }

    public static unsafe void SetPipeTimeout(IntPtr handle, byte pipeId, uint milliseconds)
    {
        if (!WinUsb_SetPipePolicy(handle, pipeId, PIPE_TRANSFER_TIMEOUT, sizeof(uint), &milliseconds))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "WinUsb_SetPipePolicy failed");
        }
    }

    /// <returns>Number of bytes read, or <c>null</c> on timeout.</returns>
    public static unsafe int? Read(IntPtr handle, byte pipeId, byte[] buffer)
    {
        fixed (byte* pointer = buffer)
        {
            if (WinUsb_ReadPipe(handle, pipeId, pointer, (uint)buffer.Length, out var transferred, IntPtr.Zero))
            {
                return (int)transferred;
            }
        }

        var error = Marshal.GetLastPInvokeError();

        if (error == ERROR_SEM_TIMEOUT)
        {
            return null;
        }

        throw new Win32Exception(error, "WinUsb_ReadPipe failed");
    }

    public static unsafe void Write(IntPtr handle, byte pipeId, ReadOnlySpan<byte> data)
    {
        fixed (byte* pointer = data)
        {
            if (!WinUsb_WritePipe(handle, pipeId, pointer, (uint)data.Length, out _, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError(), "WinUsb_WritePipe failed");
            }
        }
    }

    public static void Abort(IntPtr handle, byte pipeId) => WinUsb_AbortPipe(handle, pipeId);

    private static int QueryInterfaceNumber(IntPtr handle) =>
        WinUsb_QueryInterfaceSettings(handle, 0, out var descriptor) ? descriptor.bInterfaceNumber : -1;

    public void Dispose()
    {
        foreach (var handle in _associatedHandles)
        {
            WinUsb_Free(handle);
        }

        _associatedHandles.Clear();
        WinUsb_Free(_rootHandle);
        _file.Dispose();
    }
}
