using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jobomate.Contracts;
using Microsoft.Data.Sqlite;

namespace Jobomate.Persistence;

/// <summary>
/// Lightweight document-style SQLite store. Each entity type gets one table
/// (<c>Id TEXT PK, Data TEXT JSON, UpdatedAt TEXT</c>). Data volumes for a personal
/// job hunt are tiny, so collections are filtered in memory; this keeps the schema
/// trivial and the domain model the single source of truth.
/// </summary>
public sealed class JobomateDb
{
    public string ConnectionString { get; }

    public JobomateDb(string? dbPath = null)
    {
        var path = dbPath ?? JobomatePaths.DbPath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        ConnectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
        }.ToString();
    }

    /// <summary>An in-memory database for tests (kept alive by the returned connection).</summary>
    public static (JobomateDb Db, SqliteConnection Keepalive) CreateInMemory()
    {
        var cs = new SqliteConnectionStringBuilder
        {
            DataSource = "jobomate-" + Guid.NewGuid().ToString("n"),
            Mode = SqliteOpenMode.Memory,
            Cache = SqliteCacheMode.Shared,
        }.ToString();
        var keepalive = new SqliteConnection(cs);
        keepalive.Open();
        return (new JobomateDb(cs, fromConnectionString: true), keepalive);
    }

    private JobomateDb(string connectionString, bool fromConnectionString)
    {
        ConnectionString = connectionString;
    }
}

/// <summary>Generic JSON-backed repository for one <see cref="IEntity"/> type.</summary>
public sealed class Repository<T> where T : class, IEntity, new()
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _cs;
    private readonly string _table;

    public Repository(JobomateDb db)
    {
        _cs = db.ConnectionString;
        _table = "t_" + typeof(T).Name;
        Exec($"CREATE TABLE IF NOT EXISTS {_table} (Id TEXT PRIMARY KEY, Data TEXT NOT NULL, UpdatedAt TEXT NOT NULL)");
    }

    public void Upsert(T entity)
    {
        if (string.IsNullOrEmpty(entity.Id))
            entity.Id = Guid.NewGuid().ToString("n");

        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"INSERT OR REPLACE INTO {_table} (Id, Data, UpdatedAt) VALUES ($id, $data, $ts)";
        cmd.Parameters.AddWithValue("$id", entity.Id);
        cmd.Parameters.AddWithValue("$data", JsonSerializer.Serialize(entity, JsonOpts));
        cmd.Parameters.AddWithValue("$ts", DateTimeOffset.UtcNow.ToString("o"));
        cmd.ExecuteNonQuery();
    }

    public void UpsertAll(IEnumerable<T> entities)
    {
        foreach (var e in entities) Upsert(e);
    }

    public T? Get(string id)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT Data FROM {_table} WHERE Id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        var data = cmd.ExecuteScalar() as string;
        return data is null ? null : JsonSerializer.Deserialize<T>(data, JsonOpts);
    }

    public IReadOnlyList<T> All()
    {
        var list = new List<T>();
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT Data FROM {_table} ORDER BY UpdatedAt DESC";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            var item = JsonSerializer.Deserialize<T>(reader.GetString(0), JsonOpts);
            if (item is not null) list.Add(item);
        }
        return list;
    }

    public void Delete(string id)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"DELETE FROM {_table} WHERE Id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.ExecuteNonQuery();
    }

    public int Count()
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM {_table}";
        return Convert.ToInt32(cmd.ExecuteScalar());
    }

    private SqliteConnection Open()
    {
        var conn = new SqliteConnection(_cs);
        conn.Open();
        return conn;
    }

    private void Exec(string sql)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
