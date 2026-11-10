using System.Net;
using System.Text;
using Newtonsoft.Json.Linq;

const string endpoint = "https://api.powerplatform.com/copilotstudio-mcp/tenants/efb073bb-283b-4757-a252-22af963721bc/environments/75660de8-d408-e9ce-bc60-84d4f6a30d0b/agents/Default_Failure_Mode_Identifier_20cdd7";
int checks = 0;
void Check(bool valid, string name) { if (!valid) throw new Exception(name); checks++; }
JObject Request(string method) => new JObject {
    ["jsonrpc"] = "2.0", ["id"] = "test", ["method"] = method,
    ["params"] = method == "initialize" ? new JObject { ["protocolVersion"] = "2025-03-26" } :
        new JObject { ["name"] = "send-message", ["arguments"] = new JObject { ["message"] = "Read-only fictional DFMEA test" } }
};
FakeContext Context(JObject body, Func<HttpRequestMessage, Task<HttpResponseMessage>> send) => new FakeContext {
    Request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = ScriptBase.CreateJsonContent(body.ToString()) },
    OperationId = "FailureModeMcp", Send = send
};
HttpResponseMessage Stream(string text, string type = "text/event-stream") =>
    new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(text, Encoding.UTF8, type) };
string Event(JObject result) => "event: message\ndata: " + new JObject { ["jsonrpc"] = "2.0", ["id"] = "test", ["result"] = result }.ToString(Newtonsoft.Json.Formatting.None) + "\n\n";
var original = Event(new JObject { ["content"] = new JArray() });
var normal = Context(Request("tools/call"), request => {
    Check(request.Headers.Accept.ToString() == "application/json, text/event-stream", "Dual Accept");
    Check(request.Headers.GetValues("MCP-Protocol-Version").Single() == "2025-03-26", "Protocol header");
    return Task.FromResult(Stream(original));
});
var response = await new Script { Context = normal }.ExecuteAsync();
Check(response.StatusCode == HttpStatusCode.OK, "Tool response status");
Check((string)JObject.Parse(await response.Content.ReadAsStringAsync())["events"] == original, "SSE preserved");
int sends = 0;
var handshake = Context(Request("initialize"), async request => {
    sends++;
    if (sends == 1) return Stream(Event(new JObject { ["protocolVersion"] = "2025-03-26" }));
    var notification = JObject.Parse(await request.Content.ReadAsStringAsync());
    Check((string)notification["method"] == "notifications/initialized" && notification["id"] == null, "Initialized notification");
    Check(request.RequestUri.AbsoluteUri == endpoint, "Notification same endpoint");
    return new HttpResponseMessage(HttpStatusCode.Accepted);
});
Check((await new Script { Context = handshake }.ExecuteAsync()).StatusCode == HttpStatusCode.OK && sends == 2, "Complete handshake");
foreach (var mutation in new Action<FakeContext>[] {
    c => c.OperationId = "arbitrary",
    c => c.Request.RequestUri = new Uri("https://example.com/"),
    c => c.Request.RequestUri = new Uri(endpoint + "?arbitrary=1"),
    c => c.Request.Content = ScriptBase.CreateJsonContent("{\"jsonrpc\":\"2.0\",\"id\":\"test\",\"method\":\"tools/call\",\"params\":{\"name\":\"delete\",\"arguments\":{\"message\":\"x\"}}}")
}) {
    var bad = Context(Request("tools/call"), _ => throw new Exception("Invalid request was forwarded"));
    mutation(bad);
    Check((await new Script { Context = bad }.ExecuteAsync()).StatusCode == HttpStatusCode.BadRequest, "Endpoint/tool rejection");
}
var upstreamFailure = Context(Request("tools/call"), _ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("PRIVATE") }));
var failure = await new Script { Context = upstreamFailure }.ExecuteAsync();
Check(failure.StatusCode == HttpStatusCode.Forbidden && !(await failure.Content.ReadAsStringAsync()).Contains("PRIVATE"), "Safe upstream failure");
var oversized = Context(Request("tools/call"), _ => Task.FromResult(Stream(new string('x', 524289))));
Check((await new Script { Context = oversized }.ExecuteAsync()).StatusCode == HttpStatusCode.BadGateway, "Response bound");
var invalidType = Context(Request("tools/call"), _ => Task.FromResult(Stream("html", "text/html")));
Check((await new Script { Context = invalidType }.ExecuteAsync()).StatusCode == HttpStatusCode.BadGateway, "Content-type guard");
Console.WriteLine($"{checks} custom connector script checks passed.");

public abstract class ScriptBase {
    public FakeContext Context { get; set; }
    public CancellationToken CancellationToken { get; set; }
    public static StringContent CreateJsonContent(string text) => new StringContent(text, Encoding.UTF8, "application/json");
    public abstract Task<HttpResponseMessage> ExecuteAsync();
}
public class FakeContext {
    public HttpRequestMessage Request { get; set; }
    public string OperationId { get; set; }
    public Func<HttpRequestMessage, Task<HttpResponseMessage>> Send { get; set; }
    public Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Send(request);
}
