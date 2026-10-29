#!/usr/bin/env python3
"""Synthetic app-server; never reads credentials or sends model requests."""
import json
import os
import sys


def responses_fixture():
    """Loopback-only inference for the installed CLI; no model or credential access."""
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from pathlib import Path

    directory = Path(os.environ["CODEX_FIXTURE_RESPONSES_DIR"])
    class Handler(BaseHTTPRequestHandler):
        turn = 0

        def log_message(self, *_):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            turn = Handler.turn
            Handler.turn += 1
            (directory / f"response-request-{turn}.json").write_text(json.dumps(request))
            if turn < 3:
                server = "terminal_v4_browser" if turn < 2 else "user_fixture"
                namespace = f"mcp__{server}"
                catalog = request.get("tools", [])
                namespaced = any(tool.get("type") == "namespace" and tool.get("name") == namespace
                                 for tool in catalog)
                item = {"id": f"fc_{turn}", "call_id": f"call_{turn}", "type": "function_call",
                        "name": "browser_close" if namespaced else f"{namespace}__browser_close",
                        "arguments": "{}", "status": "completed"}
                if namespaced:
                    item["namespace"] = namespace
            else:
                item = {"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": "Local fixture finished", "annotations": []}]}
            response = {"id": f"resp_{turn}", "object": "response", "created_at": 1,
                        "model": request["model"], "status": "completed", "output": [item],
                        "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110}}
            events = [
                {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0,
                 "item": {**item, "status": "in_progress", **({"arguments": ""} if turn < 3 else {})}},
            ]
            if turn < 3:
                events.append({"type": "response.function_call_arguments.delta", "item_id": item["id"],
                               "output_index": 0, "delta": "{}"})
            events.extend([
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": response},
            ])
            body = "".join(f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': index})}\n\n"
                           for index, event in enumerate(events)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    print(f"http://127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()


if "--responses-fixture" in sys.argv:
    responses_fixture()
    sys.exit(0)


def emit(packet):
    print(json.dumps(packet), flush=True)


def finish(status="completed"):
    item_id = "reply-" + str(os.getpid())
    emit({"method": "item/started", "params": {"threadId": "native-fixture", "item": {"id": item_id, "type": "agentMessage"}}})
    emit({"method": "item/agentMessage/delta", "params": {"threadId": "native-fixture", "itemId": item_id, "delta": "Local Codex reply"}})
    emit({"method": "item/completed", "params": {"threadId": "native-fixture", "item": {"id": item_id, "type": "agentMessage", "text": "Local Codex reply"}}})
    emit({"method": "turn/completed", "params": {"threadId": "native-fixture", "turn": {"id": "native-turn", "status": status}}})


for line in sys.stdin:
    packet = json.loads(line)
    if os.getenv("CODEX_FIXTURE_LOG"):
        with open(os.environ["CODEX_FIXTURE_LOG"], "a") as log:
            log.write(json.dumps(packet) + "\n")
    method = packet.get("method")
    if method == "initialize":
        emit({"id": packet["id"], "result": {"userAgent": "fixture"}})
    elif method == "account/read":
        account = None if os.getenv("CODEX_FIXTURE_SIGNED_OUT") else {"type": "chatgpt"}
        emit({"id": packet["id"], "result": {"account": account, "requiresOpenaiAuth": True}})
    elif method in ("thread/start", "thread/resume"):
        browser = packet["params"].get("config", {}).get("mcp_servers.terminal_v4_browser")
        if os.getenv("CODEX_FIXTURE_RESUME_ERROR") and method == "thread/resume":
            emit({"id": packet["id"], "error": {"code": -32000, "message": "Thread unavailable"}})
        else:
            emit({"id": packet["id"], "result": {"thread": {"id": "native-fixture"}}})
    elif method == "turn/start":
        emit({"id": packet["id"], "result": {"turn": {"id": "native-turn"}}})
        text = packet["params"]["input"][0]["text"]
        if text in ("browser-approval-question", "browser-approval-elicitation"):
            emit({"method": "item/started", "params": {"threadId": "native-fixture", "turnId": "native-turn", "item": {"id": "browser-call", "type": "mcpToolCall", "server": "terminal_v4_browser", "tool": "browser_navigate", "arguments": {"url": "http://localhost:5173/example"}}}})
            params = {"threadId": "native-fixture", "turnId": "native-turn"}
            if text.endswith("question"):
                params.update({"itemId": "browser-call", "isBlocking": True, "questions": [{"id": "mcp_tool_call_approval_browser-call", "header": "Approve app tool call?", "question": "Allow this browser navigation?", "options": [{"label": "Allow", "description": "Run once"}, {"label": "Cancel", "description": "Cancel"}]}]})
                method = "item/tool/requestUserInput"
            else:
                params.update({"serverName": "terminal_v4_browser", "mode": "form", "message": "Allow this browser navigation?", "requestedSchema": {"type": "object", "properties": {}}, "_meta": {"codex_approval_kind": "mcp_tool_call", "tool_params": {"url": "http://localhost:5173/example"}}})
                method = "mcpServer/elicitation/request"
            emit({"id": "browser-approval", "method": method, "params": params})
        elif text == "browser-echo":
            emit({"method": "error", "params": {"error": {"message": "fixture echoed " + browser["http_headers"]["Authorization"]}}})
            finish()
        elif text.startswith("approval"):
            emit({"id": "native-approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "native-fixture", "turnId": "native-turn", "itemId": "command", "command": "printf fixture", "reason": "Run the fixture command"}})
            if text == "approval-pair":
                emit({"method": "item/started", "params": {"threadId": "native-fixture", "turnId": "native-turn", "item": {"id": "files", "type": "fileChange", "status": "inProgress", "changes": [{"path": "/fixture/example.txt", "kind": {"type": "add"}, "diff": "+fixture"}]}}})
                emit({"id": "native-approval-two", "method": "item/fileChange/requestApproval", "params": {"threadId": "native-fixture", "turnId": "native-turn", "itemId": "files"}})
            if text == "approval-fragment":
                sys.stdout.write('{"method":"item/agentMessage/delta","params":{"threadId":"native-fixture","itemId":"fragment","delta":"frag')
                sys.stdout.flush()
                with open(os.environ["CODEX_FIXTURE_LOG"] + ".fragment", "w") as marker:
                    marker.write("started")
        elif text == "question":
            emit({"id": "user-question", "method": "item/tool/requestUserInput", "params": {"threadId": "native-fixture", "turnId": "native-turn", "itemId": "ask", "questions": [{"id": "colour", "header": "Theme", "question": "Which accent colour?", "options": [{"label": "Indigo", "description": "Matches T3"}, {"label": "Amber", "description": "The old look"}]}]}})
        elif text == "exit-after-burst":
            import subprocess
            import time
            subprocess.Popen([sys.executable, "-c", "import time; time.sleep(6)"])
            time.sleep(0.1)
            for _ in range(32):
                emit({"method": "item/agentMessage/delta", "params": {"threadId": "native-fixture", "itemId": "reply", "delta": "x"}})
            finish()
            os._exit(0)
        elif text.startswith("hold"):
            emit({"method": "item/agentMessage/delta", "params": {"threadId": "native-fixture", "itemId": "reply", "delta": "Working"}})
        else:
            finish()
    elif packet.get("id") == "browser-approval":
        finish()
    elif packet.get("id") == "native-approval":
        if text == "approval-fragment":
            sys.stdout.write('ment"}}\n')
            sys.stdout.flush()
        if text != "approval-pair":
            finish()
    elif packet.get("id") == "native-approval-two":
        finish()
    elif packet.get("id") == "user-question":
        finish()
    elif method == "turn/interrupt":
        emit({"id": packet["id"], "result": {}})
        emit({"method": "turn/completed", "params": {"threadId": "native-fixture", "turn": {"id": "native-turn", "status": "interrupted"}}})
