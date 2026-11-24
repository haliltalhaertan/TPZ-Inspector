#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TPZ Inspector — Zero-Dependency Standalone Server (Python Standard Library Only).
Serves both the compiled React Web UI (../web/dist) and the full Local Power Engine API
(/api/health, /api/archives, /api/archives/upload, /api/archives/load-path, /api/objects/*, /api/search)
without requiring pip/venv installation on Windows or Linux.
"""

from __future__ import annotations

import argparse
import email.parser
import json
import mimetypes
import os
import re
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import List, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine import LocalTpzEngine  # noqa: E402

WEB_DIST = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web", "dist"))
ENGINE = LocalTpzEngine()

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


def normalize_disk_path(raw_path: str) -> str:
    p = (raw_path or "").strip().strip('"').strip("'")
    if os.name != "nt" and len(p) >= 3 and p[1] == ":" and p[2] in ("\\", "/"):
        drive = p[0].lower()
        rest = p[3:].replace("\\", "/")
        wsl_cand = f"/mnt/{drive}/{rest}"
        if os.path.exists(wsl_cand):
            return wsl_cand
    return p


def parse_multipart_files(content_type: str, body: bytes) -> List[Tuple[str, bytes]]:
    """Fast, zero-copy binary multipart/form-data parser (handles large .tpz files cleanly)."""
    m = re.search(r'boundary=(?:"([^"]+)"|([^;\s]+))', content_type, flags=re.I)
    if not m:
        return []
    boundary_str = m.group(1) or m.group(2)
    delimiter = b"--" + boundary_str.encode("utf-8")
    parts = body.split(delimiter)
    files: List[Tuple[str, bytes]] = []

    for part in parts[1:]:
        if part.startswith(b"--"):
            break
        if part.startswith(b"\r\n"):
            part = part[2:]
        elif part.startswith(b"\n"):
            part = part[1:]

        sep_idx = part.find(b"\r\n\r\n")
        sep_len = 4
        if sep_idx < 0:
            sep_idx = part.find(b"\n\n")
            sep_len = 2
        if sep_idx < 0:
            continue

        raw_headers = part[:sep_idx].decode("utf-8", "replace")
        payload = part[sep_idx + sep_len:]
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        elif payload.endswith(b"\n"):
            payload = payload[:-1]

        fname = ""
        fn_star = re.search(r"filename\*=UTF-8''([^;\r\n]+)", raw_headers, flags=re.I)
        if fn_star:
            fname = urllib.parse.unquote(fn_star.group(1).strip())
        else:
            fn_match = re.search(r'filename="([^"]*)"', raw_headers, flags=re.I)
            if fn_match:
                fname = fn_match.group(1)

        if fname and payload:
            clean_fname = os.path.basename(fname.replace("\\", "/")) or "uploaded.tpz"
            files.append((clean_fname, payload))

    return files


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def _configure_stdio_for_windowless() -> None:
    """When launched via pythonw.exe on Windows, sys.stdout/sys.stderr are None.
    Redirect them cleanly to backend/server.log so logging never crashes."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.log")
    try:
        mode = "w" if (os.path.isfile(log_path) and os.path.getsize(log_path) > 2 * 1024 * 1024) else "a"
        log_fp = open(log_path, mode, encoding="utf-8", buffering=1, errors="replace")
    except OSError:
        log_fp = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = log_fp
    if sys.stderr is None:
        sys.stderr = log_fp


class TpzStudioHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        if sys.stdout is not None:
            try:
                sys.stdout.write(f"[TPZ Inspector] {self.address_string()} - {fmt % args}\n")
                sys.stdout.flush()
            except Exception:
                pass

    def _send_json(self, status: int, data: dict) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Connection", "close")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            self.close_connection = True

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or "0")
        return self.rfile.read(length) if length > 0 else b""

    def do_OPTIONS(self) -> None:
        try:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            self.close_connection = True

    def do_GET(self) -> None:
        try:
            self._handle_get()
        except Exception as exc:
            self._send_json(500, {"detail": f"Server error: {exc}"})

    def _handle_get(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path

        if path == "/api/health":
            self._send_json(200, {"ok": True, "serverVersion": "1.2.0", **ENGINE.capabilities()})
            return

        if path == "/api/archives":
            self._send_json(200, {"archives": list(ENGINE.archives.values())})
            return

        m_ver = re.fullmatch(r"/api/archives/([^/]+)/verify", path)
        if m_ver:
            arch_id = urllib.parse.unquote(m_ver.group(1))
            try:
                self._send_json(200, ENGINE.verify_archive(arch_id))
            except KeyError as exc:
                self._send_json(404, {"detail": str(exc)})
            return

        if path.startswith("/api/objects/"):
            obj_id = urllib.parse.unquote(path[len("/api/objects/"):]).strip("/")
            try:
                self._send_json(200, ENGINE.get_object_detail(obj_id))
            except KeyError as exc:
                self._send_json(404, {"detail": str(exc)})
            return

        if path == "/api/search":
            qs = urllib.parse.parse_qs(parsed.query)
            q = (qs.get("q") or [""])[0]
            limit = int((qs.get("limit") or ["200"])[0])
            self._send_json(200, ENGINE.global_search(q, limit=limit))
            return

        # Serve static files from ../web/dist
        self._serve_static(path)

    def do_POST(self) -> None:
        try:
            self._handle_post()
        except Exception as exc:
            self._send_json(500, {"detail": f"Server error: {exc}"})

    def _handle_post(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path

        if path == "/api/archives/upload":
            ctype = self.headers.get("Content-Type", "")
            body = self._read_body()
            uploads = parse_multipart_files(ctype, body)
            if not uploads:
                self._send_json(400, {"detail": "No .tpz file received in multipart upload."})
                return
            loaded = []
            try:
                for fname, raw in uploads:
                    loaded.append(ENGINE.load_tpz_bytes(fname, raw))
                self._send_json(200, {"loaded": loaded, "capabilities": ENGINE.capabilities()})
            except Exception as exc:
                self._send_json(400, {"detail": str(exc)})
            return

        if path == "/api/archives/load-path":
            body = self._read_body()
            try:
                payload = json.loads(body.decode("utf-8", "replace"))
            except Exception:
                self._send_json(400, {"detail": "Invalid JSON body"})
                return

            raw_req_path = payload.get("path", "")
            target = normalize_disk_path(raw_req_path)
            if not os.path.exists(target):
                self._send_json(404, {"detail": f"Path not found: {raw_req_path}"})
                return

            tpz_files: List[str] = []
            if os.path.isfile(target):
                tpz_files.append(target)
            elif os.path.isdir(target):
                for dp, _dns, fns in os.walk(target):
                    for fn in sorted(fns):
                        if fn.lower().endswith(".tpz"):
                            tpz_files.append(os.path.join(dp, fn))
                    if len(tpz_files) >= 150:
                        break

            if not tpz_files:
                self._send_json(400, {"detail": "No .tpz files found at the specified path."})
                return

            loaded = []
            errors = []
            for fp in tpz_files:
                try:
                    with open(fp, "rb") as f:
                        loaded.append(ENGINE.load_tpz_bytes(os.path.basename(fp), f.read()))
                except Exception as exc:
                    errors.append({"file": os.path.basename(fp), "error": str(exc)})

            self._send_json(200, {"loaded": loaded, "errors": errors, "capabilities": ENGINE.capabilities()})
            return

        m_rep = re.fullmatch(r"/api/archives/([^/]+)/repack", path)
        if m_rep:
            arch_id = urllib.parse.unquote(m_rep.group(1))
            body = self._read_body()
            try:
                payload = json.loads(body.decode("utf-8", "replace")) if body else {}
            except Exception:
                self._send_json(400, {"detail": "Invalid JSON body"})
                return
            try:
                out_name, out_bytes, summary = ENGINE.repack_archive(
                    arch_id,
                    replacements=payload.get("replacements"),
                    channel_patches=payload.get("channelPatches"),
                    sanitize=bool(payload.get("sanitize", False)),
                    include_header=bool(payload.get("includeHeader", False)),
                )
                req_name = (payload.get("outputName") or "").strip()
                if req_name:
                    out_name = os.path.basename(req_name.replace("\\", "/"))
                    if not out_name.lower().endswith(".tpz"):
                        out_name += ".tpz"
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Length", str(len(out_bytes)))
                    self.send_header("Content-Disposition", f'attachment; filename="{out_name}"')
                    self.send_header("X-TPZ-Repack-Summary", json.dumps(summary, ensure_ascii=True))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Access-Control-Expose-Headers", "Content-Disposition, X-TPZ-Repack-Summary")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(out_bytes)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
                finally:
                    self.close_connection = True
            except KeyError as exc:
                self._send_json(404, {"detail": str(exc)})
            except Exception as exc:
                self._send_json(400, {"detail": str(exc)})
            return

        m_sim = re.fullmatch(r"/api/objects/([^/]+)/simulate", path)
        if m_sim:
            obj_id = urllib.parse.unquote(m_sim.group(1))
            body = self._read_body()
            try:
                payload = json.loads(body.decode("utf-8", "replace")) if body else {}
            except Exception:
                self._send_json(400, {"detail": "Invalid JSON body"})
                return
            try:
                res = ENGINE.simulate_mapping_object(
                    obj_id,
                    source_xml=payload.get("sourceXml", ""),
                    execute_java_udfs=bool(payload.get("executeJavaUdfs", True)),
                )
                self._send_json(200, res)
            except KeyError as exc:
                self._send_json(404, {"detail": str(exc)})
            except Exception as exc:
                self._send_json(400, {"detail": str(exc)})
            return

        m_dec = re.fullmatch(r"/api/objects/([^/]+)/decompile/(\d+)", path)
        if m_dec:
            obj_id = urllib.parse.unquote(m_dec.group(1))
            res_idx = int(m_dec.group(2))
            try:
                self._send_json(200, ENGINE.decompile_class(obj_id, res_idx))
            except (KeyError, IndexError) as exc:
                self._send_json(404, {"detail": str(exc)})
            return

        self._send_json(404, {"detail": f"Unknown endpoint: {path}"})

    def do_DELETE(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            path = parsed.path
            if path.startswith("/api/archives/"):
                arch_id = urllib.parse.unquote(path[len("/api/archives/"):]).strip("/")
                ENGINE.remove_archive(arch_id)
                self._send_json(200, {"ok": True, "capabilities": ENGINE.capabilities()})
                return
            self._send_json(404, {"detail": "Not found"})
        except Exception as exc:
            self._send_json(500, {"detail": f"Server error: {exc}"})

    def _serve_static(self, req_path: str) -> None:
        rel = req_path.lstrip("/") or "index.html"
        safe_rel = os.path.normpath(rel).replace("\\", "/")
        if safe_rel.startswith(".."):
            self._send_json(403, {"detail": "Forbidden"})
            return

        candidate = os.path.join(WEB_DIST, safe_rel)
        if not os.path.isfile(candidate):
            candidate = os.path.join(WEB_DIST, "index.html")

        if not os.path.isfile(candidate):
            msg = b"Web UI dist folder not found. Run 'npm run build' in web/."
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(msg)
            self.close_connection = True
            return

        ctype, _ = mimetypes.guess_type(candidate)
        with open(candidate, "rb") as f:
            content = f.read()

        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache" if candidate.endswith(".html") else "public, max-age=3600")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            self.close_connection = True


def is_already_running(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/api/health", timeout=1.2) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
            return bool(data.get("ok"))
    except Exception:
        return False


def main() -> None:
    _configure_stdio_for_windowless()
    ap = argparse.ArgumentParser(description="TPZ Inspector Local Server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        print("SELF-TEST OK:", json.dumps(ENGINE.capabilities()))
        print("WEB_DIST_EXISTS:", os.path.isfile(os.path.join(WEB_DIST, "index.html")))
        return

    url = f"http://{args.host}:{args.port}"
    if is_already_running(url):
        print(f"TPZ Inspector is already running at {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return

    server = ReusableThreadingHTTPServer((args.host, args.port), TpzStudioHandler)
    caps = ENGINE.capabilities()
    print("=" * 62)
    print(f"  TPZ Inspector is LIVE at: {url}")
    print(f"  Java: {caps['hasJava']} | javap: {caps['hasJavap']} | CFR: {caps['hasCfr']} ({caps['cfrJar']})")
    print("  Keep this window open while using Local Power Mode.")
    print("  Press Ctrl+C to stop.")
    print("=" * 62)
    sys.stdout.flush()

    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down TPZ Inspector...")
        server.server_close()


if __name__ == "__main__":
    main()
