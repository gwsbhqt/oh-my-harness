"""只监听本机的无敏感浏览器验收页面。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import threading
import urllib.parse

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/query":
            body=json.dumps({"name":urllib.parse.parse_qs(parsed.query).get("name", [""])[0]}).encode()
            content="application/json"
        elif parsed.path == "/download":
            body=b"browser-control download fixture";content="text/plain"
        elif parsed.path == "/frame":
            body='<html><label>嵌套输入<input id="frame-input"></label><button id="frame-button">嵌套按钮</button></html>'.encode();content="text/html; charset=utf-8"
        else:
            body=(Path(__file__).parent / "fixtures" / "main.html").read_bytes();content="text/html; charset=utf-8"
        self.send_response(200);self.send_header("Content-Type",content);self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)
    def log_message(self, *args):
        pass

class FixtureServer:
    def __enter__(self):
        self.server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f"http://127.0.0.1:{self.server.server_port}"
        return self
    def __exit__(self,*args):
        self.server.shutdown();self.server.server_close();self.thread.join(2)

if __name__=="__main__":
    with FixtureServer() as fixture:
        print(fixture.url,flush=True)
        threading.Event().wait()
