#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TPZ Inspector — Silent Windows Explorer .tpz / Folder Opener.
Invoked cleanly via pythonw.exe when double-clicking a .tpz file or choosing
"TPZ Inspector ile Aç" from the Windows Explorer context menu.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from typing import Any, Dict, List, Optional

BASE_URL = "http://127.0.0.1:8765"
SYSTEM_TYPES = {"FOLDER", "namespdecl", "workspace"}
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(BACKEND_DIR, "opener.log")
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def _log(msg: str) -> None:
    try:
        with open(LOG_PATH, "a", encoding="utf-8", errors="replace") as fp:
            fp.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except OSError:
        pass


def _is_server_alive(timeout: float = 0.7) -> bool:
    try:
        with urllib.request.urlopen(f"{BASE_URL}/api/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def _ensure_server_running() -> bool:
    if _is_server_alive():
        return True
    server_script = os.path.join(BACKEND_DIR, "standalone_server.py")
    py_exe = sys.executable
    if os.name == "nt" and py_exe.lower().endswith("python.exe"):
        cand = py_exe[:-10] + "pythonw.exe"
        if os.path.isfile(cand):
            py_exe = cand
    try:
        subprocess.Popen(
            [py_exe, server_script, "--no-browser"],
            cwd=BACKEND_DIR,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW,
        )
    except Exception as exc:
        _log(f"Failed to start standalone_server.py: {exc}")
        return False

    deadline = time.time() + 7.0
    while time.time() < deadline:
        if _is_server_alive(timeout=0.5):
            return True
        time.sleep(0.2)
    return False


def _load_path_into_server(target_path: str) -> Optional[Dict[str, Any]]:
    payload = json.dumps({"path": target_path}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/api/archives/load-path",
        data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        _log(f"HTTP {exc.code} loading {target_path}: {body}")
    except Exception as exc:
        _log(f"Error loading {target_path}: {exc}")
    return None


def _should_open_browser() -> bool:
    """Prevent opening 10 tabs when user selects multiple .tpz files and hits Enter."""
    lock_file = os.path.join(tempfile.gettempdir(), "tpz_studio_browser_open.ts")
    now = time.time()
    try:
        if os.path.isfile(lock_file):
            last = float(open(lock_file, "r", encoding="utf-8").read().strip() or "0")
            if now - last < 1.2:
                return False
        with open(lock_file, "w", encoding="utf-8") as fp:
            fp.write(f"{now:.3f}")
    except Exception:
        pass
    return True


def _pick_target_url(resp: Optional[Dict[str, Any]]) -> str:
    if not resp:
        return f"{BASE_URL}/"
    loaded: List[Dict[str, Any]] = resp.get("loaded") or []
    if len(loaded) == 1:
        objs = [o for o in (loaded[0].get("objects") or []) if o.get("typeId") not in SYSTEM_TYPES]
        # If the clicked .tpz holds a single primary object (e.g., 1 Channel or 1 Mapping), jump straight to it!
        if len(objs) == 1:
            return f"{BASE_URL}/#/o/{urllib.parse.quote(objs[0]['id'], safe='')}"
    return f"{BASE_URL}/#/"


def main(argv: List[str]) -> int:
    targets = [a.strip().strip('"') for a in argv[1:] if a.strip()]
    if not _ensure_server_running():
        _log("Server failed to come online.")
        return 1

    last_resp: Optional[Dict[str, Any]] = None
    for t in targets:
        if os.path.exists(t):
            _log(f"Opening target: {t}")
            last_resp = _load_path_into_server(t)
        else:
            _log(f"Target path not found: {t}")

    url = _pick_target_url(last_resp)
    if _should_open_browser():
        try:
            webbrowser.open(url, new=2)
        except Exception as exc:
            _log(f"webbrowser.open failed: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
