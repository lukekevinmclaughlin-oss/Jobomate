using System;
using Jobomate.Email;

namespace Jobomate.Scheduling;

/// <summary>Injectable clock so the scheduler is deterministic in tests.</summary>
public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

/// <summary>Injectable jitter so spacing is deterministic in tests.</summary>
public interface IJitterSource
{
    TimeSpan Next(TimeSpan min, TimeSpan max);
}

public sealed class RandomJitter : IJitterSource
{
    private readonly Random _random;
    public RandomJitter(Random? random = null) => _random = random ?? new Random();

    public TimeSpan Next(TimeSpan min, TimeSpan max)
    {
        if (max <= min) return min;
        var span = (max - min).TotalSeconds;
        return min + TimeSpan.FromSeconds(_random.NextDouble() * span);
    }
}

public sealed class FixedJitter : IJitterSource
{
    private readonly TimeSpan _value;
    public FixedJitter(TimeSpan value) => _value = value;
    public TimeSpan Next(TimeSpan min, TimeSpan max) => _value;
}

/// <summary>Default safe sending limits (per the spec).</summary>
public sealed class RateLimitConfig
{
    public int MaxPerDay { get; set; } = 8;
    public TimeSpan MinGap { get; set; } = TimeSpan.FromMinutes(25);
    public TimeSpan JitterMin { get; set; } = TimeSpan.FromMinutes(5);
    public TimeSpan JitterMax { get; set; } = TimeSpan.FromMinutes(15);
    public int QuietStartHour { get; set; } = 20; // 20:00
    public int QuietEndHour { get; set; } = 8;     // 08:00
    public string TimeZoneId { get; set; } = "Europe/Berlin";

    public int MaxConsecutiveFailures { get; set; } = 3;
}

/// <summary>
/// Pure rate-limiter: computes the next allowed send instant honoring the minimum gap,
/// jitter, the daily cap, and quiet hours in the configured timezone (Europe/Berlin).
/// </summary>
public static class SendScheduler
{
    public static DateTimeOffset ComputeNextSlot(
        RateLimitConfig cfg, DateTimeOffset now, DateTimeOffset? lastSend, int sentToday, TimeSpan jitter)
    {
        var tz = ResolveTimeZone(cfg.TimeZoneId);

        var earliest = now;
        if (lastSend is { } last)
        {
            var afterGap = last + cfg.MinGap;
            if (afterGap > earliest) earliest = afterGap;
        }
        earliest += jitter;

        var local = TimeZoneInfo.ConvertTime(earliest, tz);

        // Daily cap: move to the start of the next allowed window (next day, quiet-end).
        if (sentToday >= cfg.MaxPerDay)
            local = AtLocalTime(local.DateTime.Date.AddDays(1), cfg.QuietEndHour, tz);

        return ApplyQuietHours(local, cfg, tz);
    }

    public static bool IsQuietHour(RateLimitConfig cfg, DateTimeOffset instant)
    {
        var tz = ResolveTimeZone(cfg.TimeZoneId);
        var hour = TimeZoneInfo.ConvertTime(instant, tz).Hour;
        return hour >= cfg.QuietStartHour || hour < cfg.QuietEndHour;
    }

    private static DateTimeOffset ApplyQuietHours(DateTimeOffset local, RateLimitConfig cfg, TimeZoneInfo tz)
    {
        var hour = local.Hour;
        if (hour >= cfg.QuietStartHour)
            return AtLocalTime(local.DateTime.Date.AddDays(1), cfg.QuietEndHour, tz);
        if (hour < cfg.QuietEndHour)
            return AtLocalTime(local.DateTime.Date, cfg.QuietEndHour, tz);
        return local;
    }

    private static DateTimeOffset AtLocalTime(DateTime date, int hour, TimeZoneInfo tz)
    {
        var local = new DateTime(date.Year, date.Month, date.Day, hour, 0, 0, DateTimeKind.Unspecified);
        return new DateTimeOffset(local, tz.GetUtcOffset(local));
    }

    private static TimeZoneInfo ResolveTimeZone(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch { return TimeZoneInfo.Utc; }
    }
}

public enum QueueState { Running, Paused, Stopped }

/// <summary>
/// Maps a send failure to the queue's next state. Stops immediately on auth, bounce, or
/// permanent errors and on repeated transient failures; pauses on throttling.
/// </summary>
public static class SendPolicy
{
    public static (QueueState State, bool ItemPermanentlyFailed) Evaluate(
        EmailErrorKind error, int priorConsecutiveFailures, int maxConsecutiveFailures = 3)
    {
        return error switch
        {
            EmailErrorKind.None => (QueueState.Running, false),
            // Auth stops the whole queue but the item itself is fine (retry after re-auth).
            EmailErrorKind.Auth => (QueueState.Stopped, false),
            EmailErrorKind.Bounce => (QueueState.Stopped, true),
            EmailErrorKind.Permanent => (QueueState.Stopped, true),
            EmailErrorKind.Throttle => (QueueState.Paused, false),
            EmailErrorKind.Transient => priorConsecutiveFailures + 1 >= maxConsecutiveFailures
                ? (QueueState.Stopped, false)
                : (QueueState.Paused, false),
            _ => (QueueState.Paused, false),
        };
    }
}
