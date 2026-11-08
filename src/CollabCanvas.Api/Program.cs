using CollabCanvas.Api.Hubs;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR();
// Redis is journal-only (T-5) — the app must boot without it.
// AbortOnConnectFail=false: the mux returns immediately and retries
// in the background; /health reports "degraded" until it lands.
builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
    ConnectionMultiplexer.Connect(ConfigurationOptions.Parse(
        (builder.Configuration.GetConnectionString("Redis") ?? "localhost:6379")
        + ",abortConnect=false")));

// Dev frontend on :5173 (vite) and :3100 (compose nginx) call the API
// cross-origin — SignalR negotiate needs CORS for those origins.
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins("http://localhost:5173", "http://localhost:3100")
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

var app = builder.Build();
app.UseCors();

app.MapGet("/health", async (IConnectionMultiplexer redis, CancellationToken ct) =>
{
    var redisOk = false;
    try { redisOk = (await redis.GetDatabase().PingAsync()).TotalMilliseconds >= 0; }
    catch (RedisException) { /* fail-open: report degraded, don't throw */ }

    return Results.Json(
        new { status = redisOk ? "ok" : "degraded", redis = redisOk },
        statusCode: redisOk ? 200 : 503);
});

app.MapHub<DocumentHub>("/hubs/document");

app.Run();

// Marker for WebApplicationFactory<Program> in tests.
public partial class Program;
