namespace XqzProbe;

internal sealed record USBEndpoint(byte Address, byte Attributes, ushort MaxPacketSize)
{
    public bool IsIn => (Address & 0x80) != 0;

    public int TransferType => Attributes & 0x03;

    public bool IsBulk => TransferType == 2;

    public string TypeName =>
        TransferType switch
        {
            0 => "control",
            1 => "isochronous",
            2 => "bulk",
            _ => "interrupt",
        };
}

internal sealed record USBInterface(
    byte Number,
    byte AlternateSetting,
    byte Class,
    byte SubClass,
    byte Protocol,
    List<USBEndpoint> Endpoints
)
{
    public (USBEndpoint? In, USBEndpoint? Out) FindBulkPair()
    {
        USBEndpoint? epIn = null;
        USBEndpoint? epOut = null;

        foreach (var endpoint in Endpoints)
        {
            if (!endpoint.IsBulk)
            {
                continue;
            }

            if (endpoint.IsIn)
            {
                epIn = endpoint;
            }
            else
            {
                epOut = endpoint;
            }
        }

        return (epIn, epOut);
    }
}

internal sealed record USBConfiguration(byte Value, byte NumInterfaces, List<USBInterface> Interfaces)
{
    public static USBConfiguration Parse(ReadOnlySpan<byte> data)
    {
        if (data.Length < 9 || data[1] != NativeMethods.USB_CONFIGURATION_DESCRIPTOR_TYPE)
        {
            throw new InvalidDataException("invalid configuration descriptor");
        }

        var interfaces = new List<USBInterface>();
        USBInterface? current = null;
        var offset = 0;

        while (offset + 2 <= data.Length)
        {
            var length = data[offset];

            if (length < 2 || offset + length > data.Length)
            {
                break;
            }

            var type = data[offset + 1];
            var descriptor = data.Slice(offset, length);

            if (type == NativeMethods.USB_INTERFACE_DESCRIPTOR_TYPE && length >= 9)
            {
                current = new USBInterface(
                    descriptor[2],
                    descriptor[3],
                    descriptor[5],
                    descriptor[6],
                    descriptor[7],
                    []
                );
                interfaces.Add(current);
            }
            else if (type == NativeMethods.USB_ENDPOINT_DESCRIPTOR_TYPE && length >= 7 && current is not null)
            {
                current.Endpoints.Add(
                    new USBEndpoint(descriptor[2], descriptor[3], (ushort)(descriptor[4] | (descriptor[5] << 8)))
                );
            }

            offset += length;
        }

        return new USBConfiguration(data[5], data[4], interfaces);
    }
}
