public class Script : ScriptBase
{
    public override async Task<HttpResponseMessage> ExecuteAsync()
    {
        const string prefix = "/copilotstudio-mcp/tenants/efb073bb-283b-4757-a252-22af963721bc/environments/75660de8-d408-e9ce-bc60-84d4f6a30d0b/agents/";
        string agent;
        switch (this.Context.OperationId)
        {
            case "FailureModeMcp": agent = "Default_Failure_Mode_Identifier_20cdd7"; break;
            case "RiskMcp": agent = "Default_Failure_Risk_Prioritizer_5a9a6a"; break;
            case "ActionMcp": agent = "Default_Corrective_Action_Advisor_7867b1"; break;
            default: return Error(HttpStatusCode.BadRequest, "Unsupported specialist operation.");
        }

        var uri = this.Context.Request.RequestUri;
        if (uri.Scheme != "https" || uri.Host != "api.powerplatform.com" ||
            uri.AbsolutePath != prefix + agent || uri.Query.Length != 0)
            return Error(HttpStatusCode.BadRequest, "Unexpected specialist endpoint.");

        var body = await this.Context.Request.Content.ReadAsStringAsync().ConfigureAwait(false);
        if (body.Length > 65536)
            return Error(HttpStatusCode.BadRequest, "The specialist request exceeded the size limit.");
        JObject request;
        try { request = JObject.Parse(body); }
        catch (Newtonsoft.Json.JsonException) { return Error(HttpStatusCode.BadRequest, "Invalid MCP request."); }
        var method = (string)request["method"];
        var parameters = request["params"] as JObject;
        if ((string)request["jsonrpc"] != "2.0" || parameters == null ||
            (method != "initialize" && method != "tools/list" && method != "tools/call"))
            return Error(HttpStatusCode.BadRequest, "Unsupported MCP request.");
        if (request["id"] == null || request["id"].Type != JTokenType.String ||
                 ((string)request["id"]).Length == 0 || ((string)request["id"]).Length > 128)
            return Error(HttpStatusCode.BadRequest, "Invalid MCP request identifier.");
        if (method == "initialize" && (string)parameters["protocolVersion"] != "2025-03-26")
            return Error(HttpStatusCode.BadRequest, "Unsupported MCP protocol.");
        if (method == "tools/call")
        {
            var arguments = parameters["arguments"] as JObject;
            Guid conversation;
            if ((string)parameters["name"] != "send-message" || arguments == null ||
                arguments["message"] == null || arguments["message"].Type != JTokenType.String ||
                ((string)arguments["message"]).Length == 0 || ((string)arguments["message"]).Length > 32768 ||
                (arguments["conversationId"] != null &&
                 (arguments["conversationId"].Type != JTokenType.String ||
                  !Guid.TryParse((string)arguments["conversationId"], out conversation))))
                return Error(HttpStatusCode.BadRequest, "Unsupported specialist tool arguments.");
        }

        this.Context.Request.Headers.Accept.Clear();
        this.Context.Request.Headers.Accept.ParseAdd("application/json, text/event-stream");
        this.Context.Request.Headers.Remove("MCP-Protocol-Version");
        this.Context.Request.Headers.TryAddWithoutValidation("MCP-Protocol-Version", "2025-03-26");
        using (var upstream = await this.Context.SendAsync(this.Context.Request, this.CancellationToken).ConfigureAwait(false))
        {
            if (!upstream.IsSuccessStatusCode)
                return Error(upstream.StatusCode, "The specialist service rejected the request.");
            var contentType = upstream.Content.Headers.ContentType;
            if (contentType == null ||
                (contentType.MediaType != "application/json" && contentType.MediaType != "text/event-stream"))
                return Error(HttpStatusCode.BadGateway, "Unsupported specialist response format.");

            const int limit = 524288;
            using (var stream = await upstream.Content.ReadAsStreamAsync().ConfigureAwait(false))
            using (var reader = new StreamReader(stream))
            {
                var text = new StringBuilder();
                var buffer = new char[4096];
                int count;
                while ((count = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0)
                {
                    this.CancellationToken.ThrowIfCancellationRequested();
                    if (text.Length + count > limit)
                        return Error(HttpStatusCode.BadGateway, "The specialist response exceeded the size limit.");
                    text.Append(buffer, 0, count);
                }
                var events = text.ToString();
                if (method == "initialize")
                {
                    JObject initialized;
                    try
                    {
                        var payload = events.Trim();
                        if (!payload.StartsWith("{", StringComparison.Ordinal))
                        {
                            var lines = new StringBuilder();
                            foreach (var line in payload.Split('\n'))
                                if (line.StartsWith("data:", StringComparison.Ordinal))
                                    lines.AppendLine(line.Substring(5).TrimStart());
                            payload = lines.ToString();
                        }
                        initialized = JObject.Parse(payload);
                    }
                    catch (Newtonsoft.Json.JsonException)
                    {
                        return Error(HttpStatusCode.BadGateway, "Invalid MCP initialization response.");
                    }
                    if (initialized["error"] == null &&
                        (string)initialized["id"] == (string)request["id"] &&
                        (string)initialized["result"]?["protocolVersion"] == "2025-03-26")
                    {
                        // Complete the MCP handshake inside the same authenticated transport operation.
                        using (var notification = new HttpRequestMessage(HttpMethod.Post, uri))
                        {
                            foreach (var header in this.Context.Request.Headers)
                                notification.Headers.TryAddWithoutValidation(header.Key, header.Value);
                            notification.Content = CreateJsonContent("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\",\"params\":{}}");
                            using (var acknowledged = await this.Context.SendAsync(notification, this.CancellationToken).ConfigureAwait(false))
                                if (!acknowledged.IsSuccessStatusCode)
                                    return Error(HttpStatusCode.BadGateway, "MCP initialization was not acknowledged.");
                        }
                    }
                }
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = CreateJsonContent(new JObject { ["events"] = events }.ToString())
                };
            }
        }
    }

    private static HttpResponseMessage Error(HttpStatusCode status, string message)
    {
        return new HttpResponseMessage(status)
        {
            Content = CreateJsonContent(new JObject { ["error"] = message }.ToString())
        };
    }
}
