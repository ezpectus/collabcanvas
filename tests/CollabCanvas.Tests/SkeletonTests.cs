using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using CollabCanvas.Core.Protocol;

namespace CollabCanvas.Tests;

// T-2 scaffold smoke: the app boots, /health answers its contract,
// SignalR negotiates, and the op-protocol DTOs round-trip on the wire.
// Real behavior lands in T-3..T-7; these guards make CI meaningful
// from day one.
public class SkeletonTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Health_AnswersContract()
    {
        var client = factory.CreateClient();
        var resp = await client.GetAsync("/health");
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(resp.StatusCode is HttpStatusCode.OK or HttpStatusCode.ServiceUnavailable);
        Assert.True(body.GetProperty("status").GetString() is "ok" or "degraded");
        Assert.True(body.GetProperty("redis").ValueKind is JsonValueKind.True or JsonValueKind.False);
    }

    [Fact]
    public async Task Hub_Negotiate_Works()
    {
        var client = factory.CreateClient();
        var resp = await client.PostAsync("/hubs/document/negotiate?negotiateVersion=1", null);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.TryGetProperty("connectionId", out _));
    }

    [Fact]
    public void OpProtocol_RoundTrips()
    {
        var op = new OpSubmit("doc-1", "client-A", 42, OpType.Patch,
            JsonDocument.Parse("""{"x":120}""").RootElement);
        var json = JsonSerializer.Serialize(op);
        var back = JsonSerializer.Deserialize<OpSubmit>(json)!;

        Assert.Equal("doc-1", back.DocId);
        Assert.Equal(42, back.ClientSeq);
        Assert.Equal(OpType.Patch, back.Type);
        Assert.Equal(120, back.Payload.GetProperty("x").GetInt32());
    }
}
