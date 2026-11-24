#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TPZ Viewer - FastAPI Local Bridge & Static Server.

Endpoints:
- GET  /api/health                  -> capabilities (CFR, javap, loaded archives/objects)
- GET  /api/archives                -> list currently loaded TPZ archives
- POST /api/archives/upload         -> upload one or more .tpz files into local engine
- POST /api/archives/load-path      -> load .tpz file or directory of .tpz files directly from disk path
- DELETE /api/archives/{archive_id} -> unload archive
- GET  /api/objects/{object_id}     -> full object detail (mapping graph, fields, UDFs, channels, XML, XSD/WSDL)
- POST /api/objects/{object_id}/decompile/{resource_index} -> on-demand CFR / javap .class decompilation
- GET  /api/search?q=...            -> instant cross-archive search across objects, fields, UDFs, channels, docs
"""

from __future__ import annotations

import os
from typing import Dict, List, Optional
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from engine import LocalTpzEngine

app = FastAPI(
    title="TPZ Inspector — Local Power Engine",
    version="1.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-TPZ-Repack-Summary"],
)

engine = LocalTpzEngine()


class LoadPathRequest(BaseModel):
    path: str


class RepackRequest(BaseModel):
    replacements: Optional[List[Dict[str, str]]] = None
    channelPatches: Optional[List[Dict[str, str]]] = None
    sanitize: bool = False
    includeHeader: bool = False
    outputName: Optional[str] = None


def normalize_disk_path(raw_path: str) -> str:
    p = (raw_path or "").strip().strip('"').strip("'")
    # Support Windows paths like C:\Users\... when backend runs inside WSL
    if os.name != "nt" and len(p) >= 3 and p[1] == ":" and p[2] in ("\\", "/"):
        drive = p[0].lower()
        rest = p[3:].replace("\\", "/")
        wsl_cand = f"/mnt/{drive}/{rest}"
        if os.path.exists(wsl_cand):
            return wsl_cand
    return p


@app.get("/api/health")
def health():
    return {
        "ok": True,
        **engine.capabilities(),
    }


@app.get("/api/archives")
def list_archives():
    return {
        "archives": list(engine.archives.values()),
    }


@app.post("/api/archives/upload")
async def upload_archives(files: List[UploadFile] = File(...)):
    loaded = []
    for f in files:
        raw = await f.read()
        if not raw:
            continue
        try:
            summary = engine.load_tpz_bytes(f.filename or "uploaded.tpz", raw)
            loaded.append(summary)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"loaded": loaded, "capabilities": engine.capabilities()}


@app.post("/api/archives/load-path")
def load_from_path(req: LoadPathRequest):
    target = normalize_disk_path(req.path)
    if not os.path.exists(target):
        raise HTTPException(status_code=404, detail=f"Path not found: {req.path}")

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
        raise HTTPException(status_code=400, detail="No .tpz files found at the specified path.")

    loaded = []
    errors = []
    for fp in tpz_files:
        try:
            with open(fp, "rb") as f:
                raw = f.read()
            loaded.append(engine.load_tpz_bytes(os.path.basename(fp), raw))
        except Exception as exc:
            errors.append({"file": os.path.basename(fp), "error": str(exc)})

    return {
        "loaded": loaded,
        "errors": errors,
        "capabilities": engine.capabilities(),
    }


@app.get("/api/archives/{archive_id}/verify")
def verify_archive(archive_id: str):
    try:
        return engine.verify_archive(archive_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/archives/{archive_id}/repack")
def repack_archive(archive_id: str, req: RepackRequest):
    import json
    try:
        out_name, out_bytes, summary = engine.repack_archive(
            archive_id,
            replacements=req.replacements,
            channel_patches=req.channelPatches,
            sanitize=req.sanitize,
            include_header=req.includeHeader,
        )
        if req.outputName and req.outputName.strip():
            out_name = os.path.basename(req.outputName.strip().replace("\\", "/"))
            if not out_name.lower().endswith(".tpz"):
                out_name += ".tpz"
        return Response(
            content=out_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{out_name}"',
                "X-TPZ-Repack-Summary": json.dumps(summary, ensure_ascii=True),
            },
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/archives/{archive_id}")
def delete_archive(archive_id: str):
    engine.remove_archive(archive_id)
    return {"ok": True, "capabilities": engine.capabilities()}


@app.get("/api/objects/{object_id}")
def get_object(object_id: str):
    try:
        return engine.get_object_detail(object_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class SimulateRequest(BaseModel):
    sourceXml: str
    executeJavaUdfs: bool = True


@app.post("/api/objects/{object_id}/simulate")
def simulate_object_mapping(object_id: str, req: SimulateRequest):
    try:
        return engine.simulate_mapping_object(object_id, req.sourceXml, req.executeJavaUdfs)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/objects/{object_id}/decompile/{resource_index}")
def decompile_object_class(object_id: str, resource_index: int):
    try:
        return engine.decompile_class(object_id, resource_index)
    except (KeyError, IndexError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/search")
def search_all(q: str = Query("", min_length=1), limit: int = Query(200, ge=1, le=1000)):
    return engine.global_search(q, limit=limit)


# Mount built static Web UI if available
WEB_DIST = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web", "dist"))
if os.path.isdir(WEB_DIST):
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="static")
