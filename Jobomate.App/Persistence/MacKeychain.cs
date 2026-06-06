using System;
using System.IO;
using System.Runtime.InteropServices;

namespace Jobomate.Persistence;

/// <summary>
/// Minimal P/Invoke bridge to the macOS Keychain (Security.framework generic
/// passwords). Stores opaque byte blobs keyed by (service, account). This is
/// the single native interop point for macOS secret storage; both
/// <see cref="KeychainCredentialStore"/> and the AppServices credential helper
/// route through it, so there is one place that talks to the Keychain.
///
/// macOS-only: every entry point throws <see cref="PlatformNotSupportedException"/>
/// elsewhere, so a mis-wire fails loudly instead of silently degrading to a
/// plaintext file.
/// </summary>
public static class MacKeychain
{
    private const string SecurityPath =
        "/System/Library/Frameworks/Security.framework/Security";
    private const string CoreFoundationPath =
        "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

    private const int ErrSecSuccess = 0;
    private const int ErrSecItemNotFound = -25300;
    private const uint KCFStringEncodingUTF8 = 0x08000100;

    // --- CoreFoundation ---
    [DllImport(CoreFoundationPath)]
    private static extern IntPtr CFStringCreateWithCString(IntPtr alloc,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string cStr, uint encoding);
    [DllImport(CoreFoundationPath)]
    private static extern IntPtr CFDataCreate(IntPtr alloc, byte[] bytes, long length);
    [DllImport(CoreFoundationPath)]
    private static extern long CFDataGetLength(IntPtr data);
    [DllImport(CoreFoundationPath)]
    private static extern IntPtr CFDataGetBytePtr(IntPtr data);
    [DllImport(CoreFoundationPath)]
    private static extern IntPtr CFDictionaryCreate(IntPtr alloc, IntPtr[] keys, IntPtr[] values,
        long numValues, IntPtr keyCallBacks, IntPtr valueCallBacks);
    [DllImport(CoreFoundationPath)]
    private static extern void CFRelease(IntPtr cf);

    // --- Security ---
    [DllImport(SecurityPath)]
    private static extern int SecItemCopyMatching(IntPtr query, out IntPtr result);
    [DllImport(SecurityPath)]
    private static extern int SecItemAdd(IntPtr attributes, IntPtr result);
    [DllImport(SecurityPath)]
    private static extern int SecItemUpdate(IntPtr query, IntPtr attributesToUpdate);
    [DllImport(SecurityPath)]
    private static extern int SecItemDelete(IntPtr query);

    // Constant CFStringRef / struct symbols are resolved lazily on first use so
    // merely loading this type on a non-macOS host never dlopen's the frameworks.
    private static readonly Lazy<Native> N = new(() => new Native());

    private sealed class Native
    {
        public readonly IntPtr SecClass, GenericPassword, AttrService, AttrAccount, ValueData,
            ReturnData, MatchLimit, MatchLimitOne, Accessible, AccessibleAfterFirstUnlockThisDeviceOnly,
            BooleanTrue, DictKeyCallbacks, DictValueCallbacks;

        public Native()
        {
            var sec = NativeLibrary.Load(SecurityPath);
            var cf = NativeLibrary.Load(CoreFoundationPath);
            SecClass = Deref(sec, "kSecClass");
            GenericPassword = Deref(sec, "kSecClassGenericPassword");
            AttrService = Deref(sec, "kSecAttrService");
            AttrAccount = Deref(sec, "kSecAttrAccount");
            ValueData = Deref(sec, "kSecValueData");
            ReturnData = Deref(sec, "kSecReturnData");
            MatchLimit = Deref(sec, "kSecMatchLimit");
            MatchLimitOne = Deref(sec, "kSecMatchLimitOne");
            Accessible = Deref(sec, "kSecAttrAccessible");
            AccessibleAfterFirstUnlockThisDeviceOnly =
                Deref(sec, "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly");
            BooleanTrue = Deref(cf, "kCFBooleanTrue");
            // Callback tables are passed by address (not dereferenced).
            DictKeyCallbacks = NativeLibrary.GetExport(cf, "kCFTypeDictionaryKeyCallBacks");
            DictValueCallbacks = NativeLibrary.GetExport(cf, "kCFTypeDictionaryValueCallBacks");
        }

        private static IntPtr Deref(IntPtr lib, string symbol) =>
            Marshal.ReadIntPtr(NativeLibrary.GetExport(lib, symbol));
    }

    // Headless / CI / automated-test escape hatch. When JOBOMATE_DISABLE_KEYCHAIN is
    // set (1/true), all Keychain access is skipped: Get returns null (callers then
    // treat the store as empty and fall back to environment variables / inline
    // config) and Set is a no-op. Prevents a blocking GUI Keychain access prompt on
    // unsigned/dev/headless runs whose code signature is not in the item's ACL. The
    // signed app never sets this, so end users are unaffected.
    private static bool Disabled
    {
        get
        {
            var v = Environment.GetEnvironmentVariable("JOBOMATE_DISABLE_KEYCHAIN");
            return !string.IsNullOrEmpty(v) && (v == "1" || v.Equals("true", StringComparison.OrdinalIgnoreCase));
        }
    }

    /// <summary>Reads the blob for (service, account), or null if absent.</summary>
    public static byte[]? Get(string service, string account)
    {
        if (Disabled) return null;
        EnsureMac();
        var n = N.Value;
        IntPtr svc = CFStr(service), acc = CFStr(account);
        IntPtr query = Dict(
            (n.SecClass, n.GenericPassword),
            (n.AttrService, svc),
            (n.AttrAccount, acc),
            (n.ReturnData, n.BooleanTrue),
            (n.MatchLimit, n.MatchLimitOne));
        try
        {
            int status = SecItemCopyMatching(query, out IntPtr result);
            if (status == ErrSecItemNotFound || result == IntPtr.Zero) return null;
            if (status != ErrSecSuccess)
                throw new IOException($"Keychain read failed for {account}: OSStatus {status}");
            try
            {
                long len = CFDataGetLength(result);
                var bytes = new byte[len];
                if (len > 0) Marshal.Copy(CFDataGetBytePtr(result), bytes, 0, (int)len);
                return bytes;
            }
            finally { CFRelease(result); }
        }
        finally { CFRelease(query); CFRelease(svc); CFRelease(acc); }
    }

    /// <summary>Writes the blob for (service, account), updating in place if present.</summary>
    public static void Set(string service, string account, byte[] data)
    {
        if (Disabled) return;
        EnsureMac();
        var n = N.Value;
        IntPtr svc = CFStr(service), acc = CFStr(account);
        IntPtr cfData = CFDataCreate(IntPtr.Zero, data, data.LongLength);
        IntPtr baseQuery = Dict(
            (n.SecClass, n.GenericPassword),
            (n.AttrService, svc),
            (n.AttrAccount, acc));
        IntPtr updateAttrs = Dict(
            (n.ValueData, cfData),
            (n.Accessible, n.AccessibleAfterFirstUnlockThisDeviceOnly));
        try
        {
            // Update-before-add: never create a duplicate item for the same key.
            int status = SecItemUpdate(baseQuery, updateAttrs);
            if (status == ErrSecItemNotFound)
            {
                IntPtr addDict = Dict(
                    (n.SecClass, n.GenericPassword),
                    (n.AttrService, svc),
                    (n.AttrAccount, acc),
                    (n.ValueData, cfData),
                    (n.Accessible, n.AccessibleAfterFirstUnlockThisDeviceOnly));
                try
                {
                    int add = SecItemAdd(addDict, IntPtr.Zero);
                    if (add != ErrSecSuccess)
                        throw new IOException($"Keychain add failed for {account}: OSStatus {add}");
                }
                finally { CFRelease(addDict); }
            }
            else if (status != ErrSecSuccess)
            {
                throw new IOException($"Keychain update failed for {account}: OSStatus {status}");
            }
        }
        finally { CFRelease(updateAttrs); CFRelease(baseQuery); CFRelease(cfData); CFRelease(svc); CFRelease(acc); }
    }

    /// <summary>Removes the item for (service, account); no-op if absent.</summary>
    public static void Delete(string service, string account)
    {
        if (Disabled) return;
        EnsureMac();
        var n = N.Value;
        IntPtr svc = CFStr(service), acc = CFStr(account);
        IntPtr query = Dict(
            (n.SecClass, n.GenericPassword),
            (n.AttrService, svc),
            (n.AttrAccount, acc));
        try
        {
            int status = SecItemDelete(query);
            if (status != ErrSecSuccess && status != ErrSecItemNotFound)
                throw new IOException($"Keychain delete failed for {account}: OSStatus {status}");
        }
        finally { CFRelease(query); CFRelease(svc); CFRelease(acc); }
    }

    private static IntPtr CFStr(string s) =>
        CFStringCreateWithCString(IntPtr.Zero, s, KCFStringEncodingUTF8);

    private static IntPtr Dict(params (IntPtr key, IntPtr val)[] pairs)
    {
        var n = N.Value;
        var keys = new IntPtr[pairs.Length];
        var vals = new IntPtr[pairs.Length];
        for (int i = 0; i < pairs.Length; i++) { keys[i] = pairs[i].key; vals[i] = pairs[i].val; }
        return CFDictionaryCreate(IntPtr.Zero, keys, vals, pairs.Length, n.DictKeyCallbacks, n.DictValueCallbacks);
    }

    private static void EnsureMac()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            throw new PlatformNotSupportedException("MacKeychain is macOS-only.");
    }
}
