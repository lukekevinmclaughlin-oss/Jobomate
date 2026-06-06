using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Jobomate.Extension;

/// <summary>
/// Minimal loopback WebSocket server (RFC 6455 text frames) implemented over TcpListener,
/// because <c>HttpListener</c> WebSocket support is Windows-only. Used by the Chrome
/// extension bridge so a persistent connection keeps the MV3 service worker alive.
/// One active client (the extension) at a time.
/// </summary>
public sealed class JobomateWsServer
{
    private const string WsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private readonly int _port;
    private TcpListener? _listener;
    private CancellationTokenSource? _cts;
    private NetworkStream? _client;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly object _gate = new();

    public JobomateWsServer(int port) => _port = port;

    public bool IsConnected { get; private set; }
    public event Action<string>? MessageReceived;
    public event Action<bool>? ConnectionChanged;

    public void Start()
    {
        lock (_gate)
        {
            if (_listener is not null) return;
            _cts = new CancellationTokenSource();
            _listener = new TcpListener(IPAddress.Loopback, _port);
            _listener.Start();
        }
        _ = AcceptLoopAsync(_cts!.Token);
    }

    public void Stop()
    {
        lock (_gate)
        {
            _cts?.Cancel();
            try { _listener?.Stop(); } catch { }
            _listener = null;
        }
    }

    public async Task SendAsync(string json)
    {
        NetworkStream? stream;
        lock (_gate) stream = _client;
        if (stream is null) return;

        var frame = EncodeTextFrame(json);
        await _sendLock.WaitAsync().ConfigureAwait(false);
        try { await stream.WriteAsync(frame).ConfigureAwait(false); }
        catch { /* client gone */ }
        finally { _sendLock.Release(); }
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await _listener!.AcceptTcpClientAsync(ct).ConfigureAwait(false); }
            catch { break; }
            _ = HandleClientAsync(client, ct);
        }
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken ct)
    {
        using var _ = client;
        client.NoDelay = true;
        var stream = client.GetStream();
        try
        {
            if (!await HandshakeAsync(stream, ct).ConfigureAwait(false)) return;

            lock (_gate) { _client = stream; IsConnected = true; }
            ConnectionChanged?.Invoke(true);

            await ReadLoopAsync(stream, ct).ConfigureAwait(false);
        }
        catch { /* drop */ }
        finally
        {
            lock (_gate)
            {
                if (ReferenceEquals(_client, stream)) { _client = null; IsConnected = false; }
            }
            ConnectionChanged?.Invoke(false);
        }
    }

    private static async Task<bool> HandshakeAsync(NetworkStream stream, CancellationToken ct)
    {
        var headerText = await ReadHttpHeaderAsync(stream, ct).ConfigureAwait(false);
        if (headerText is null) return false;

        string? key = null;
        foreach (var line in headerText.Split('\n'))
        {
            var idx = line.IndexOf(':');
            if (idx <= 0) continue;
            if (line[..idx].Trim().Equals("Sec-WebSocket-Key", StringComparison.OrdinalIgnoreCase))
                key = line[(idx + 1)..].Trim();
        }
        if (key is null) return false;

        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + WsGuid)));
        var response =
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        var bytes = Encoding.ASCII.GetBytes(response);
        await stream.WriteAsync(bytes, ct).ConfigureAwait(false);
        return true;
    }

    private static async Task<string?> ReadHttpHeaderAsync(NetworkStream stream, CancellationToken ct)
    {
        var buffer = new List<byte>(1024);
        var one = new byte[1];
        while (buffer.Count < 16384)
        {
            var n = await stream.ReadAsync(one, ct).ConfigureAwait(false);
            if (n == 0) return null;
            buffer.Add(one[0]);
            var c = buffer.Count;
            if (c >= 4 && buffer[c - 4] == '\r' && buffer[c - 3] == '\n' && buffer[c - 2] == '\r' && buffer[c - 1] == '\n')
                return Encoding.ASCII.GetString(buffer.ToArray());
        }
        return null;
    }

    private async Task ReadLoopAsync(NetworkStream stream, CancellationToken ct)
    {
        var message = new List<byte>();
        while (!ct.IsCancellationRequested)
        {
            var header = await ReadExactAsync(stream, 2, ct).ConfigureAwait(false);
            if (header is null) return;

            var fin = (header[0] & 0x80) != 0;
            var opcode = header[0] & 0x0F;
            var masked = (header[1] & 0x80) != 0;
            long len = header[1] & 0x7F;

            if (len == 126)
            {
                var ext = await ReadExactAsync(stream, 2, ct).ConfigureAwait(false);
                if (ext is null) return;
                len = (ext[0] << 8) | ext[1];
            }
            else if (len == 127)
            {
                var ext = await ReadExactAsync(stream, 8, ct).ConfigureAwait(false);
                if (ext is null) return;
                len = 0;
                for (var i = 0; i < 8; i++) len = (len << 8) | ext[i];
            }
            if (len > 8 * 1024 * 1024) return; // sanity cap

            byte[] mask = Array.Empty<byte>();
            if (masked)
            {
                mask = await ReadExactAsync(stream, 4, ct).ConfigureAwait(false) ?? Array.Empty<byte>();
                if (mask.Length < 4) return;
            }

            var payload = len == 0 ? Array.Empty<byte>() : await ReadExactAsync(stream, (int)len, ct).ConfigureAwait(false);
            if (payload is null) return;
            if (masked) for (var i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];

            switch (opcode)
            {
                case 0x8: return;                       // close
                case 0x9: await SendPongAsync(stream, payload, ct).ConfigureAwait(false); break; // ping
                case 0xA: break;                        // pong
                case 0x1:                               // text
                case 0x0:                               // continuation
                    message.AddRange(payload);
                    if (fin)
                    {
                        var text = Encoding.UTF8.GetString(message.ToArray());
                        message.Clear();
                        try { MessageReceived?.Invoke(text); } catch { }
                    }
                    break;
            }
        }
    }

    private async Task SendPongAsync(NetworkStream stream, byte[] payload, CancellationToken ct)
    {
        var frame = new byte[2 + payload.Length];
        frame[0] = 0x8A; // FIN + pong
        frame[1] = (byte)payload.Length;
        Array.Copy(payload, 0, frame, 2, payload.Length);
        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try { await stream.WriteAsync(frame, ct).ConfigureAwait(false); } catch { } finally { _sendLock.Release(); }
    }

    private static async Task<byte[]?> ReadExactAsync(NetworkStream stream, int count, CancellationToken ct)
    {
        var buffer = new byte[count];
        var offset = 0;
        while (offset < count)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(offset, count - offset), ct).ConfigureAwait(false);
            if (n == 0) return null;
            offset += n;
        }
        return buffer;
    }

    private static byte[] EncodeTextFrame(string text)
    {
        var payload = Encoding.UTF8.GetBytes(text);
        using var ms = new MemoryStream();
        ms.WriteByte(0x81); // FIN + text
        if (payload.Length < 126) ms.WriteByte((byte)payload.Length);
        else if (payload.Length <= ushort.MaxValue)
        {
            ms.WriteByte(126);
            ms.WriteByte((byte)(payload.Length >> 8));
            ms.WriteByte((byte)(payload.Length & 0xFF));
        }
        else
        {
            ms.WriteByte(127);
            for (var i = 7; i >= 0; i--) ms.WriteByte((byte)((long)payload.Length >> (8 * i) & 0xFF));
        }
        ms.Write(payload, 0, payload.Length);
        return ms.ToArray();
    }
}
