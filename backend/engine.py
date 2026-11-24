#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TPZ Viewer - Local Power Engine (In-Memory / On-Demand + SQLite Index + CFR/javap Decompiler).

Built upon proven SAP PI/PO .tpz (.tpt / .dlt) binary & XML parsing rules:
- Reads both .tpt (Directory/ESR) and .dlt (Delta) containers without exploding 100k files to disk.
- Tolerant <catalog> parser + NUL-header stream repair + CDATA/comment-masked depth-aware <p1:xiObj> scanner.
- Multi-layer !zip! / !jar! / !xml! Base64 payload decoder (recursive in-memory ZIP unpacking).
- Supports both <brick type="Dst"> and legacy <mapping destPath="..."> message mapping schemas.
- Extracts Operation Mapping links (generic/lnks), UDF Java sources, Imported Archive / Java Mapping .class files,
  Communication Channel attributes, ccBPM process/processstep flows, XSD/WSDL/XSLT payloads, and multilingual textObj docs.
- Provides on-demand CFR (.java) and javap (-p -c) decompilation using local JDK + cfr.jar.
"""

from __future__ import annotations

import base64
import binascii
import copy
import glob
import hashlib
import io
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from tpt_codec import (
    format_uuid_dashed,
    is_standard_tpt,
    normalize_uuid_hex,
    parse_known_devlines_tlvs,
    parse_pvc_element_tlvs,
    parse_pvc_version_set_tlvs,
    repack_tpz_bytes,
    unchunk_tpt,
    verify_tpz_bytes,
)
from mapping_simulator import simulate_mapping

XIOBJ_OPEN = b"<p1:xiObj"
XIOBJ_CLOSE = b"</p1:xiObj>"
BLOB_KINDS = (b"zip", b"jar", b"xml")
ZIP_MAGIC = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
CLASS_MAGIC = b"\xca\xfe\xba\xbe"

ET.register_namespace("p1", "urn:sap-com:xi")
ET.register_namespace("mp", "urn:sap-com:xi:mapping")
ET.register_namespace("tr", "urn:sap-com:xi:mapping:xitrafo")

SEG_TAG_RE = re.compile(rb"<segment\b([^>]*)>")
SEG_ATTR_RE = re.compile(rb'([\w:.\-]+)\s*=\s*"([^"]*)"')
B64_RE = re.compile(rb"!([A-Za-z]{2,6})!([^<]*)")
B64_ALPHABET = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
CTRL_RE = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")

KEY_CHANNEL_ATTRS = (
    "url", "targetdirectory", "filename", "file.encoding", "file.transfer",
    "user", "password", "timeout", "adapterstatus", "qualityofservice",
    "processingmode", "directory", "file.name", "ftp.", "http.", "proxy",
    "authentication", "header", "jms.", "mail.", "rfc.", "sftp", "soap", "rest",
)

def _discover_cfr_candidates() -> List[str]:
    candidates: List[str] = []
    env_cfr = os.environ.get("CFR_JAR", "").strip()
    if env_cfr:
        candidates.append(env_cfr)
    tools_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "tools"))
    candidates.append(os.path.join(tools_dir, "cfr-0.152.jar"))
    candidates.extend(sorted(glob.glob(os.path.join(tools_dir, "cfr*.jar")), reverse=True))
    return candidates


def _discover_javap_candidates() -> List[str]:
    candidates: List[str] = []
    exe = "javap.exe" if os.name == "nt" else "javap"
    java_home = os.environ.get("JAVA_HOME", "").strip()
    if java_home:
        candidates.append(os.path.join(java_home, "bin", exe))

    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA", "")
        prog_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        roots = [
            os.path.join(prog_files, "Java", "jdk*"),
            os.path.join(prog_files, "Eclipse Adoptium", "jdk*"),
            os.path.join(prog_files, "Microsoft", "jdk*"),
            os.path.join(prog_files, "Zulu", "zulu*"),
            os.path.join(prog_files, "Amazon Corretto", "jdk*"),
            os.path.join(local_app, "Programs", "Eclipse Adoptium", "jdk*") if local_app else "",
        ]
        for pattern in roots:
            if not pattern:
                continue
            for jdk_dir in sorted(glob.glob(pattern), reverse=True):
                candidates.append(os.path.join(jdk_dir, "bin", "javap.exe"))
    else:
        for pattern in (
            "/usr/lib/jvm/java-*/bin/javap",
            "/opt/*/java*/bin/javap",
            "/opt/java*/bin/javap",
            "/mnt/c/Program Files/Java/jdk*/bin/javap.exe",
            "/mnt/c/Program Files/Eclipse Adoptium/jdk*/bin/javap.exe",
        ):
            candidates.extend(sorted(glob.glob(pattern), reverse=True))
    return candidates


DEFAULT_CFR_CANDIDATES = _discover_cfr_candidates()
DEFAULT_JAVAP_CANDIDATES = _discover_javap_candidates()


def local_name(tag: str) -> str:
    if isinstance(tag, str) and "}" in tag:
        return tag.split("}", 1)[1]
    return tag if isinstance(tag, str) else ""


def child(elem: ET.Element, name: str) -> Optional[ET.Element]:
    for c in list(elem):
        if local_name(c.tag) == name:
            return c
    return None


def child_text(elem: ET.Element, name: str) -> str:
    c = child(elem, name)
    if c is None or c.text is None:
        return ""
    return c.text.strip()


def to_pretty_xml_str(elem: ET.Element) -> str:
    e = copy.deepcopy(elem)
    try:
        ET.indent(e, space="  ")
    except Exception:
        pass
    try:
        return ET.tostring(e, encoding="utf-8", xml_declaration=True).decode("utf-8", "replace")
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Catalog & Depth-Aware xiObj Stream Scanner
# ---------------------------------------------------------------------------
@dataclass
class SegmentInfo:
    type: str
    offset: int
    length: int
    in_object_list: bool


def find_catalog_bytes(buf: bytes) -> Tuple[Optional[bytes], int]:
    size = len(buf)
    window = 64 * 1024
    while window <= max(size, 64 * 1024):
        start = max(0, size - window)
        idx = buf.find(b"<catalog", start)
        if idx >= 0:
            return buf[idx:], idx
        if start == 0:
            break
        window *= 2
    return None, -1


def parse_catalog_bytes(cat_bytes: bytes, total_size: int, warnings: List[str]) -> List[SegmentInfo]:
    end = cat_bytes.find(b"</catalog>")
    text = cat_bytes[: end + len(b"</catalog>")] if end >= 0 else cat_bytes

    root = None
    for attempt in range(3):
        try:
            if attempt == 0:
                root = ET.fromstring(text)
                break
            elif attempt == 1:
                root = ET.fromstring(CTRL_RE.sub(b"", text))
                break
            elif attempt == 2:
                root = ET.fromstring(re.sub(rb"\x00{2,}.{0,4}", b"", text, flags=re.S))
                break
        except ET.ParseError:
            continue

    raw_segs: List[SegmentInfo] = []
    if root is not None and child(root, "segments") is not None:
        segs_el = child(root, "segments")
        for node in list(segs_el):
            tname = local_name(node.tag)
            if tname == "objectList":
                for o in list(node):
                    try:
                        raw_segs.append(SegmentInfo(
                            o.get("type", "?"),
                            int(o.get("offset", "-1")),
                            int(o.get("length", "-1")),
                            True,
                        ))
                    except ValueError:
                        pass
            elif tname == "segment":
                try:
                    raw_segs.append(SegmentInfo(
                        node.get("type", "?"),
                        int(node.get("offset", "-1")),
                        int(node.get("length", "-1")),
                        False,
                    ))
                except ValueError:
                    pass
    else:
        obj_start = text.find(b"<objectList")
        obj_end = text.find(b"</objectList>")
        for m in SEG_TAG_RE.finditer(text):
            attrs = {
                am.group(1).decode("ascii", "replace").lower(): am.group(2)
                for am in SEG_ATTR_RE.finditer(m.group(1))
            }
            try:
                off = int(attrs.get("offset", b"-1"))
                ln = int(attrs.get("length", b"-1"))
            except ValueError:
                continue
            pos = m.start()
            in_obj = obj_start >= 0 and obj_start < pos and (obj_end < 0 or pos < obj_end)
            raw_segs.append(SegmentInfo(
                attrs.get("type", b"?").decode("utf-8", "replace"),
                off, ln, in_obj,
            ))

    clean: List[SegmentInfo] = []
    for s in raw_segs:
        if s.offset < 0 or s.length <= 0 or s.offset >= total_size:
            continue
        ln = min(s.length, total_size - s.offset)
        if ln > 0:
            clean.append(SegmentInfo(s.type, s.offset, ln, s.in_object_list))
    return clean


class _Masker:
    DATA, COMMENT, CDATA = 0, 1, 2

    def __init__(self) -> None:
        self.state = self.DATA

    def mask(self, buf: bytes) -> bytes:
        out = bytearray(buf)
        n = len(buf)
        i = 0
        while i < n:
            if self.state == self.DATA:
                c = buf.find(b"<!--", i)
                d = buf.find(b"<![CDATA[", i)
                if c < 0 and d < 0:
                    break
                if d < 0 or (c >= 0 and c < d):
                    start, opener, closer, st = c, 4, b"-->", self.COMMENT
                else:
                    start, opener, closer, st = d, 9, b"]]>", self.CDATA
                e = buf.find(closer, start + opener)
                if e < 0:
                    out[start:] = b" " * (n - start)
                    self.state = st
                    break
                end = e + len(closer)
                out[start:end] = b" " * (end - start)
                i = end
            else:
                closer = b"-->" if self.state == self.COMMENT else b"]]>"
                e = buf.find(closer, i)
                if e < 0:
                    out[i:] = b" " * (n - i)
                    break
                end = e + len(closer)
                out[i:end] = b" " * (end - i)
                self.state = self.DATA
                i = end
        return bytes(out)


def _tag_end(buf: bytes, start: int) -> int:
    i = start + 1
    n = len(buf)
    quote = 0
    while i < n:
        c = buf[i]
        if quote:
            if c == quote:
                quote = 0
        elif c in (34, 39):
            quote = c
        elif c == 62:
            return i
        i += 1
    return -1


def _is_self_closing(buf: bytes, start: int, end: int) -> bool:
    j = end - 1
    while j > start and buf[j] in b" \t\r\n":
        j -= 1
    return buf[j] == 47


def _open_at(buf: bytes, k: int) -> Optional[bool]:
    j = k + len(XIOBJ_OPEN)
    if j >= len(buf):
        return None
    return buf[j] in b"> \t\r\n/"


def _find_open(mask: bytes, buf: bytes, start: int) -> Tuple[int, bool]:
    k = mask.find(XIOBJ_OPEN, start)
    while k >= 0:
        r = _open_at(buf, k)
        if r is None:
            return k, True
        if r:
            return k, False
        k = mask.find(XIOBJ_OPEN, k + 1)
    return -1, False


def _strip_nul_record_headers(raw: bytes) -> bytes:
    """Remove interleaved NUL runs + up to 4 binary header bytes without eating '<?xml' or '<p1:xi'."""
    out = bytearray()
    i = 0
    n = len(raw)
    while i < n:
        if raw[i] == 0 and i + 1 < n and raw[i + 1] == 0:
            while i < n and raw[i] == 0:
                i += 1
            skip = 0
            while skip < 4 and i < n:
                if raw[i] == 60 and (raw[i:i + 5] == b"<?xml" or raw[i:i + 6] == b"<p1:xi" or raw[i:i + 2] == b"</"):
                    break
                i += 1
                skip += 1
            continue
        out.append(raw[i])
        i += 1
    return bytes(out)


def scan_xi_objects_from_slice(raw_slice: bytes) -> List[bytes]:
    repaired = _strip_nul_record_headers(raw_slice)
    masker = _Masker()
    mask = masker.mask(repaired)
    n = len(repaired)
    i = 0
    depth = 0
    cur = bytearray()
    results: List[bytes] = []

    while i < n:
        if depth == 0:
            k, partial = _find_open(mask, repaired, i)
            if k < 0 or partial:
                break
            end = _tag_end(mask, k)
            if end < 0:
                break
            if _is_self_closing(repaired, k, end):
                results.append(repaired[k:end + 1])
                i = end + 1
                continue
            depth = 1
            cur = bytearray(repaired[k:end + 1])
            i = end + 1
        else:
            no, partial = _find_open(mask, repaired, i)
            nc = mask.find(XIOBJ_CLOSE, i)
            if nc < 0 and (no < 0 or partial):
                cur += repaired[i:]
                break
            if nc < 0 or (no >= 0 and not partial and no < nc):
                end = _tag_end(mask, no)
                if end < 0:
                    cur += repaired[i:]
                    break
                if _is_self_closing(repaired, no, end):
                    cur += repaired[i:end + 1]
                    i = end + 1
                    continue
                depth += 1
                cur += repaired[i:end + 1]
                i = end + 1
                continue
            depth -= 1
            cur += repaired[i:nc + len(XIOBJ_CLOSE)]
            i = nc + len(XIOBJ_CLOSE)
            if depth == 0:
                results.append(bytes(cur))
                cur = bytearray()

    if depth > 0 and cur:
        results.append(bytes(cur))
    return results


def parse_xi_xml_safe(raw: bytes) -> Optional[ET.Element]:
    body = raw
    if body[:5] == b"<?xml":
        gt = body.find(b"?>")
        if gt > 0:
            body = body[gt + 2:]
    for candidate in (
        body,
        re.sub(rb"\x00{2,}", b"", body),
        re.sub(rb"\x00{2,}.{0,4}", b"", body, flags=re.S),
        CTRL_RE.sub(b"", body).decode("utf-8", "replace").replace("\ufffd", "").encode("utf-8"),
    ):
        try:
            return ET.fromstring(candidate)
        except ET.ParseError:
            continue
    return None


# ---------------------------------------------------------------------------
# In-Memory Blob Decoder (!zip! / !jar! / !xml!)
# ---------------------------------------------------------------------------
@dataclass
class ExtractedResource:
    path: str
    kind: str  # "xml" | "xsd" | "wsdl" | "xsl" | "class" | "mappingtool" | "other"
    size: int
    data: bytes = field(repr=False)


def decode_b64_safe(token: bytes) -> Optional[bytes]:
    pad = (-len(token)) % 4
    padded = token + b"=" * pad
    try:
        return base64.b64decode(padded, validate=True)
    except (binascii.Error, ValueError):
        bad = sum(1 for c in token if c not in B64_ALPHABET)
        if bad > max(2, len(token) // 50):
            return None
        try:
            return base64.b64decode(padded, validate=False)
        except Exception:
            return None


def classify_resource(rel_path: str, payload: bytes) -> str:
    low = rel_path.lower()
    head = payload[:256].lstrip()
    if payload[:4] == CLASS_MAGIC or low.endswith(".class"):
        return "class"
    if b"<mappingtool" in head:
        return "mappingtool"
    if low.endswith(".wsdl") or b"wsdl:definitions" in head or b"<definitions" in head:
        return "wsdl"
    if low.endswith(".xsd") or b":schema" in head or b"<schema" in head:
        return "xsd"
    if low.endswith((".xsl", ".xslt")) or b":stylesheet" in head or b":transform" in head:
        return "xsl"
    if low.endswith(".xml") or head.startswith((b"<?xml", b"<")):
        return "xml"
    return "other"


def unpack_blobs_in_memory(xml_bytes: bytes, max_depth: int = 5) -> List[ExtractedResource]:
    resources: List[ExtractedResource] = []

    def expand_zip(data: bytes, prefix: str, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except Exception:
            return
        with zf:
            for info in zf.infolist():
                if info.is_dir() or info.file_size > 64 * 1024 * 1024:
                    continue
                try:
                    payload = zf.read(info)
                except Exception:
                    continue
                clean_name = info.filename.replace("\\", "/").lstrip("/")
                rel = f"{prefix}/{clean_name}" if prefix else clean_name
                if payload[:2] == b"PK" or payload[:4] in ZIP_MAGIC:
                    expand_zip(payload, rel, depth + 1)
                else:
                    kind = classify_resource(rel, payload)
                    resources.append(ExtractedResource(path=rel, kind=kind, size=len(payload), data=payload))

    idx = 0
    for m in B64_RE.finditer(xml_bytes):
        kind_raw = m.group(1)
        if kind_raw not in BLOB_KINDS:
            continue
        token = re.sub(rb"\s+", b"", m.group(2))
        if not token:
            continue
        decoded = decode_b64_safe(token)
        if not decoded:
            continue
        idx += 1
        kstr = kind_raw.decode("ascii", "replace")
        prefix = f"blob_{idx}_{kstr}"
        if decoded[:2] == b"PK" or decoded[:4] in ZIP_MAGIC:
            expand_zip(decoded, prefix, 1)
        else:
            rkind = classify_resource(f"{prefix}.{kstr}", decoded)
            resources.append(ExtractedResource(path=f"{prefix}.{kstr}", kind=rkind, size=len(decoded), data=decoded))

    return resources


# ---------------------------------------------------------------------------
# Message Mapping Parser (<brick> + Legacy mapping@destPath + Graph Nodes/Edges)
# ---------------------------------------------------------------------------
def parse_udfs_from_mappingtool(root: ET.Element) -> List[Dict[str, Any]]:
    udfs: List[Dict[str, Any]] = []
    for fm in root.iter():
        if local_name(fm.tag).lower() != "functionmodel":
            continue
        name = key = title = ui_title = tab = java_code = impl_type = cache_type = ""
        args_sig: List[Dict[str, str]] = []
        for c in fm:
            t = local_name(c.tag)
            if t == "name":
                name = (c.text or "").strip()
            elif t == "key":
                key = (c.text or "").strip()
            elif t == "title":
                title = (c.text or "").strip()
            elif t == "uiTitle":
                ui_title = (c.text or "").strip()
            elif t == "tab":
                tab = (c.text or "").strip()
            elif t == "signature":
                cache_type = c.get("cacheType", "")
                for arg in c:
                    if local_name(arg.tag) == "argument":
                        args_sig.append({
                            "name": arg.get("nm", ""),
                            "javaType": arg.get("jtp", ""),
                        })
            elif t == "implementation":
                impl_type = c.get("type", "")
                for ic in c:
                    if local_name(ic.tag) == "javaText" and ic.text:
                        java_code = ic.text.strip()
        if not key and not name and not java_code:
            continue
        udfs.append({
            "key": key or name,
            "name": name or title or key,
            "title": title or ui_title or name,
            "tab": tab,
            "cacheType": cache_type,
            "implementationType": impl_type,
            "arguments": args_sig,
            "javaCode": java_code,
            "lineCount": len(java_code.splitlines()) if java_code else 0,
        })
    return udfs


def parse_mappingtool_xml(xml_bytes: bytes) -> Dict[str, Any]:
    root = parse_xi_xml_safe(xml_bytes)
    if root is None:
        return {"fieldMappings": [], "udfs": [], "graphNodes": [], "graphEdges": []}

    udfs = parse_udfs_from_mappingtool(root)
    udf_by_key = {u["key"].strip().lower(): u for u in udfs if u.get("key")}
    udf_name_map = {u["key"]: u["name"] for u in udfs if u.get("key")}

    field_mappings: List[Dict[str, Any]] = []
    graph_nodes: List[Dict[str, Any]] = []
    graph_edges: List[Dict[str, Any]] = []
    node_seq = [0]

    def next_id() -> str:
        node_seq[0] += 1
        return f"n_{node_seq[0]}"

    def get_const_val(brick: ET.Element) -> str:
        for b in brick:
            if local_name(b.tag) != "bindings":
                continue
            for p in b:
                if p.get("name") == "value":
                    for c in p.iter():
                        if local_name(c.tag) == "value" and (c.text or "").strip():
                            return (c.text or "").strip()
        return ""

    def get_params_dict(brick: ET.Element) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for b in brick:
            if local_name(b.tag) != "bindings":
                continue
            for p in b:
                pname = p.get("name", "")
                if not pname:
                    continue
                for c in p.iter():
                    if local_name(c.tag) == "value" and c.text is not None:
                        out[pname] = c.text.strip()
                        break
        return out

    def render_brick_expr(brick: ET.Element, srcs: List[str], consts: List[str], used_udfs: List[str],
                          target_root_path: str, parent_node_id: Optional[str], pin_label: str, depth: int = 0) -> str:
        if depth > 45:
            return "..."
        btype = brick.get("type", "UNKNOWN")
        nid = next_id()

        if btype == "Src":
            spath = brick.get("path", "?")
            if spath and spath != "?":
                srcs.append(spath)
            graph_nodes.append({
                "id": nid,
                "kind": "source",
                "label": spath.split("/")[-1] or spath,
                "path": spath,
                "targetGroup": target_root_path,
            })
            if parent_node_id:
                graph_edges.append({"id": f"e_{nid}_{parent_node_id}", "source": nid, "target": parent_node_id, "label": pin_label})
            return spath

        fname = brick.get("fname", "?")
        fns = brick.get("fns", "")
        params = get_params_dict(brick)

        if fname == "const":
            cval = get_const_val(brick)
            if cval:
                consts.append(cval)
            graph_nodes.append({
                "id": nid,
                "kind": "const",
                "label": f"'{cval}'",
                "value": cval,
                "targetGroup": target_root_path,
            })
            if parent_node_id:
                graph_edges.append({"id": f"e_{nid}_{parent_node_id}", "source": nid, "target": parent_node_id, "label": pin_label})
            return "'" + cval.replace("'", "\\'") + "'"

        resolved_udf = udf_by_key.get(fname.strip().lower())
        is_udf = fns == "usernamespace" or resolved_udf is not None
        display_fn = resolved_udf["name"] if resolved_udf else udf_name_map.get(fname, fname)
        if is_udf:
            used_udfs.append(display_fn)

        graph_nodes.append({
            "id": nid,
            "kind": "udf" if is_udf else "func",
            "label": display_fn,
            "function": fname,
            "namespace": fns,
            "parameters": params,
            "udfKey": resolved_udf["key"] if resolved_udf else (fname if is_udf else ""),
            "targetGroup": target_root_path,
        })
        if parent_node_id:
            graph_edges.append({"id": f"e_{nid}_{parent_node_id}", "source": nid, "target": parent_node_id, "label": pin_label})

        arg_exprs: List[str] = []
        arg_idx = 0
        for child_el in brick:
            if local_name(child_el.tag) != "arg":
                continue
            pin = child_el.get("pin", str(arg_idx))
            arg_idx += 1
            for sub in child_el:
                if local_name(sub.tag) == "brick":
                    arg_exprs.append(render_brick_expr(
                        sub, srcs, consts, used_udfs, target_root_path, nid, f"arg[{pin}]", depth + 1
                    ))

        label = display_fn if fns in ("dflt", "", "usernamespace") else f"{display_fn}[{fns}]"
        return f"{label}({', '.join(arg_exprs)})"

    # 1) Standard <brick type="Dst"> schema
    for elem in root.iter():
        if local_name(elem.tag) == "brick" and elem.get("type") == "Dst":
            tpath = elem.get("path", "")
            tid = next_id()
            graph_nodes.append({
                "id": tid,
                "kind": "target",
                "label": tpath.split("/")[-1] or tpath,
                "path": tpath,
                "targetGroup": tpath,
            })
            srcs: List[str] = []
            consts: List[str] = []
            used_udfs: List[str] = []
            exprs: List[str] = []
            arg_idx = 0
            for child_el in elem:
                if local_name(child_el.tag) != "arg":
                    continue
                pin = child_el.get("pin", str(arg_idx))
                arg_idx += 1
                for sub in child_el:
                    if local_name(sub.tag) == "brick":
                        exprs.append(render_brick_expr(sub, srcs, consts, used_udfs, tpath, tid, f"in[{pin}]", 1))
            field_mappings.append({
                "targetPath": tpath,
                "expression": " | ".join(exprs) if exprs else "(empty)",
                "sources": list(dict.fromkeys(srcs)),
                "constants": list(dict.fromkeys(consts)),
                "udfs": list(dict.fromkeys(used_udfs)),
                "schemaFormat": "brick",
            })

    # 2) Legacy <mapping destPath="..."> schema
    if not field_mappings:
        def legacy_expr(model: ET.Element, srcs: List[str], consts: List[str],
                        tpath: str, parent_id: str, pin_lbl: str) -> str:
            cname = model.get("classname", "")
            nid = next_id()
            if cname == "NodeArgument":
                spath = model.get("path", "?")
                srcs.append(spath)
                graph_nodes.append({
                    "id": nid,
                    "kind": "source",
                    "label": spath.split("/")[-1] or spath,
                    "path": spath,
                    "targetGroup": tpath,
                })
                graph_edges.append({"id": f"e_{nid}_{parent_id}", "source": nid, "target": parent_id, "label": pin_lbl})
                return spath
            if cname == "Function":
                fname = model.get("name", "?")
                ns = model.get("namespace", "dflt")
                params = {
                    (p.findtext("name") or ""): (p.findtext("default") or "")
                    for p in model.findall("parameter")
                }
                if fname == "const":
                    cval = params.get("value", "")
                    consts.append(cval)
                    graph_nodes.append({
                        "id": nid,
                        "kind": "const",
                        "label": f"'{cval}'",
                        "value": cval,
                        "targetGroup": tpath,
                    })
                    graph_edges.append({"id": f"e_{nid}_{parent_id}", "source": nid, "target": parent_id, "label": pin_lbl})
                    return repr(cval)

                graph_nodes.append({
                    "id": nid,
                    "kind": "func",
                    "label": fname,
                    "function": fname,
                    "namespace": ns,
                    "parameters": params,
                    "targetGroup": tpath,
                })
                graph_edges.append({"id": f"e_{nid}_{parent_id}", "source": nid, "target": parent_id, "label": pin_lbl})

                args_list: List[str] = []
                sorted_args = sorted(model.findall("argument"), key=lambda a: int(a.get("pin", "0") or 0))
                for arg in sorted_args:
                    pin = arg.get("pin", "0")
                    for child_m in arg.findall("link/model"):
                        args_list.append(legacy_expr(child_m, srcs, consts, tpath, nid, f"arg[{pin}]"))
                for k, v in params.items():
                    if k:
                        args_list.append(f"{k}={v!r}")
                        if v:
                            consts.append(v)
                lbl = fname if ns == "dflt" else f"{fname}[{ns}]"
                return f"{lbl}({', '.join(args_list)})"
            return "?"

        for mp in root.findall(".//mapping[@destPath]"):
            tpath = mp.get("destPath", "")
            tid = next_id()
            graph_nodes.append({
                "id": tid,
                "kind": "target",
                "label": tpath.split("/")[-1] or tpath,
                "path": tpath,
                "targetGroup": tpath,
            })
            srcs, consts, exprs = [], [], []
            for m in mp.findall("model[@classname='DestinationValue']/link/model"):
                exprs.append(legacy_expr(m, srcs, consts, tpath, tid, "in"))
            field_mappings.append({
                "targetPath": tpath,
                "expression": " | ".join(exprs) if exprs else "(empty)",
                "sources": list(dict.fromkeys(srcs)),
                "constants": list(dict.fromkeys(consts)),
                "udfs": [],
                "schemaFormat": "legacy_destPath",
            })

    return {
        "fieldMappings": field_mappings,
        "udfs": udfs,
        "graphNodes": graph_nodes,
        "graphEdges": graph_edges,
    }


# ---------------------------------------------------------------------------
# Channel, Process, Texts & Object Parsers
# ---------------------------------------------------------------------------
def parse_channel_details(
    content_elem: Optional[ET.Element],
    links: Optional[List[Dict[str, Any]]] = None,
    party: str = "",
    service: str = "",
    channel_name: str = "",
) -> Optional[Dict[str, Any]]:
    if content_elem is None:
        return None
    ch_el = None
    for e in content_elem.iter():
        if local_name(e.tag) == "Channel":
            ch_el = e
            break
    if ch_el is None:
        return None

    scalars: Dict[str, str] = {}
    for c in ch_el:
        t = local_name(c.tag)
        if len(c) == 0 and (c.text or "").strip():
            scalars[t] = (c.text or "").strip()

    adapter_name = adapter_ns = ""
    if links:
        for lk in links:
            if (lk.get("role") or "").upper() in ("ADAPTER", "ADAPTERMETADATA"):
                adapter_name = lk.get("targetName", "")
                adapter_ns = lk.get("targetNamespace", "")
                break
    if not adapter_name:
        adapter_meta = child(ch_el, "AdapterMetadata")
        if adapter_meta is not None:
            key_el = child(adapter_meta, "key")
            if key_el is not None:
                elems = [x.text.strip() for x in key_el if local_name(x.tag) == "elem" and x.text]
                if elems:
                    adapter_name = elems[0]
                if len(elems) > 1:
                    adapter_ns = elems[1]
    if not adapter_name:
        adapter_name = scalars.get("MessageProtocol", "") or scalars.get("TransportProtocol", "")

    attributes: List[Dict[str, Any]] = []
    for attr in ch_el.iter():
        if local_name(attr.tag) != "Attribute":
            continue
        aname = child_text(attr, "Name")
        aval = child_text(attr, "Value")
        if not aname and not aval:
            continue
        is_key = any(k in aname.lower() for k in KEY_CHANNEL_ATTRS)
        attributes.append({
            "name": aname,
            "value": aval,
            "isKey": is_key,
        })

    raw_dir = scalars.get("ChannelDirection", "")
    direction_label = "Sender (Inbound)" if raw_dir == "I" else ("Receiver (Outbound)" if raw_dir == "O" else raw_dir)

    return {
        "party": party or scalars.get("PartyName", ""),
        "service": service or scalars.get("ServiceName", ""),
        "channelName": channel_name or scalars.get("ChannelName", ""),
        "direction": direction_label,
        "engineType": scalars.get("EngineType", ""),
        "adapterType": adapter_name,
        "adapterNamespace": adapter_ns,
        "transportProtocol": scalars.get("TransportProtocol", ""),
        "transportProtocolVersion": scalars.get("TransportProtocolVersion", ""),
        "messageProtocol": scalars.get("MessageProtocol", ""),
        "messageProtocolVersion": scalars.get("MessageProtocolVersion", ""),
        "description": scalars.get("Description", ""),
        "attributes": attributes,
    }


def extract_multilingual_texts(xi_elem: ET.Element) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    generic = child(xi_elem, "generic")
    if generic is None:
        return out
    ti = child(generic, "textInfo")
    if ti is None:
        return out
    for tobj in list(ti):
        if local_name(tobj.tag) != "textObj":
            continue
        master_lang = tobj.get("masterL", "")
        for texts in list(tobj):
            if local_name(texts.tag) != "texts":
                continue
            lang = texts.get("lang", "") or master_lang
            for tx in list(texts):
                if local_name(tx.tag) != "text":
                    continue
                body = (tx.text or "").strip()
                if body:
                    out.append({
                        "lang": lang,
                        "label": tx.get("label", ""),
                        "text": body,
                    })
    return out


def parse_process_steps(content_elem: Optional[ET.Element], links: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    if content_elem is None:
        return []
    role_to_target: Dict[str, str] = {}
    for lk in links:
        role = (lk.get("role") or "").strip().lower()
        elems = lk.get("elems") or []
        if role and elems:
            role_to_target[role] = elems[0]

    steps: List[Dict[str, str]] = []
    for el in content_elem.iter():
        t = local_name(el.tag)
        if t in ("processstep_process", "componentprocess"):
            sid = el.get("id", "")
            sname = el.get("name", "") or role_to_target.get(sid.lower(), "") or sid
            stype = el.get("type", "") or t
            steps.append({
                "id": sid,
                "name": sname,
                "type": stype,
            })
    return steps


# ---------------------------------------------------------------------------
# In-Memory Archive Session & Decompiler Manager
# ---------------------------------------------------------------------------
@dataclass
class StoredObject:
    id: str
    archive_id: str
    archive_name: str
    container_name: str
    type_id: str
    oid: str
    vid: str
    name: str
    namespace: str
    swcv_caption: str
    swcv_guid: str
    modif_by: str
    modif_at: str
    owner: str
    depth: int
    parent_oid: Optional[str]
    links: List[Dict[str, Any]]
    texts: List[Dict[str, str]]
    content_xml_bytes: bytes = field(repr=False)
    resources: List[ExtractedResource] = field(default_factory=list, repr=False)
    mapping_data: Optional[Dict[str, Any]] = None
    channel_data: Optional[Dict[str, Any]] = None
    process_steps: List[Dict[str, str]] = field(default_factory=list)
    pvc_info: Optional[Dict[str, Any]] = None


class LocalTpzEngine:
    def __init__(self) -> None:
        self.archives: Dict[str, Dict[str, Any]] = {}
        self.archive_bytes: Dict[str, bytes] = {}
        self.archive_devlines: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.objects: Dict[str, StoredObject] = {}
        self.class_cache: Dict[str, Dict[str, str]] = {}
        self.cfr_jar = self._locate_file(DEFAULT_CFR_CANDIDATES)
        self.javap_bin = self._locate_javap()
        self.java_bin = self._locate_java()
        self.javac_bin = self._locate_javac()

    def _locate_javac(self) -> Optional[str]:
        if self.java_bin:
            sibling = os.path.join(os.path.dirname(self.java_bin), "javac.exe" if self.java_bin.endswith(".exe") else "javac")
            if os.path.isfile(sibling):
                return sibling
        return shutil.which("javac")

    @staticmethod
    def _locate_file(candidates: List[str]) -> Optional[str]:
        for c in candidates:
            if c and os.path.isfile(c):
                return c
        return None

    def _locate_javap(self) -> Optional[str]:
        p = shutil.which("javap")
        if p:
            return p
        if os.name == "nt":
            return self._locate_file(DEFAULT_JAVAP_CANDIDATES)
        return self._locate_file(DEFAULT_JAVAP_CANDIDATES)

    def _locate_java(self) -> Optional[str]:
        if os.name != "nt":
            native_java = shutil.which("java")
            if native_java:
                return native_java
        if self.javap_bin:
            sibling = os.path.join(os.path.dirname(self.javap_bin), "java.exe" if self.javap_bin.endswith(".exe") else "java")
            if os.path.isfile(sibling):
                return sibling
        return shutil.which("java")

    @staticmethod
    def _to_tool_path(bin_path: str, target_path: str) -> str:
        if os.name != "nt" and bin_path.lower().endswith(".exe"):
            try:
                pr = subprocess.run(["wslpath", "-w", target_path], capture_output=True, timeout=5)
                if pr.returncode == 0 and pr.stdout:
                    return pr.stdout.decode("utf-8", "replace").strip()
            except Exception:
                pass
        return target_path

    def capabilities(self) -> Dict[str, Any]:
        return {
            "mode": "local-power",
            "hasJava": bool(self.java_bin),
            "hasJavac": bool(self.javac_bin),
            "hasJavap": bool(self.javap_bin),
            "hasCfr": bool(self.cfr_jar and self.java_bin),
            "hasRepack": True,
            "hasSimulator": True,
            "cfrJar": os.path.basename(self.cfr_jar) if self.cfr_jar else None,
            "loadedArchives": len(self.archives),
            "loadedObjects": len(self.objects),
        }

    def load_tpz_bytes(self, filename: str, raw_bytes: bytes) -> Dict[str, Any]:
        started = time.time()
        archive_id = hashlib.sha1(raw_bytes).hexdigest()[:12]
        # Remove previous copy if reloading same hash
        if archive_id in self.archives:
            self.remove_archive(archive_id)

        warnings: List[str] = []
        metadata_props: Dict[str, str] = {}
        containers_summary: List[Dict[str, Any]] = []
        created_objects: List[StoredObject] = []

        try:
            zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
        except Exception as exc:
            raise ValueError(f"Invalid TPZ/ZIP archive ({filename}): {exc}") from exc

        with zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                low = info.filename.lower()
                if low.endswith("metadata.properties") or low.endswith("export.inf"):
                    try:
                        txt = zf.read(info).decode("utf-8", "replace")
                        for line in txt.splitlines():
                            if "=" in line and not line.strip().startswith("#"):
                                k, v = line.split("=", 1)
                                metadata_props[k.strip()] = v.strip()
                    except Exception:
                        pass

            container_members = [
                i for i in zf.infolist()
                if not i.is_dir() and i.filename.lower().endswith((".tpt", ".dlt"))
            ]

            for mi in container_members:
                cname = os.path.basename(mi.filename)
                cdata = zf.read(mi)
                csize = len(cdata)
                crc_report: Optional[Dict[str, Any]] = None
                raw_xi_list: List[bytes] = []
                seg_count = 0

                # Prefer exact 1-MiB CRC32 unchunking + exact logical <catalog> framing
                exact_extracted = False
                pvc_by_oid_vid: Dict[Tuple[str, str], Dict[str, Any]] = {}
                pvc_by_oid: Dict[str, Dict[str, Any]] = {}
                vset_by_oid_vid: Dict[Tuple[str, str], Dict[str, Any]] = {}
                devlines_by_id: Dict[str, Dict[str, Any]] = {}
                header_vset_dashed = ""
                header_vset_hex = ""
                if is_standard_tpt(cdata):
                    try:
                        unchunked = unchunk_tpt(cdata)
                        crc_report = unchunked.report.to_dict()
                        crc_report["zipFlagBit3"] = bool(mi.flag_bits & 0x08)
                        header_vset_dashed = unchunked.report.header_version_set_id
                        header_vset_hex = normalize_uuid_hex(header_vset_dashed)
                        seg_count = len(unchunked.segments)
                        for seg in unchunked.segments:
                            if seg.type == "pvcVersionSet":
                                parsed_vset = parse_pvc_version_set_tlvs(seg.raw_bytes)
                                if parsed_vset and parsed_vset.get("exactConsumed"):
                                    for row in parsed_vset.get("rows") or []:
                                        vset_by_oid_vid[(row["oid"], row["vid"])] = {
                                            "versionSetId": format_uuid_dashed(row["versionSetId"]),
                                            "matchesHeader": bool(header_vset_hex and row["versionSetId"] == header_vset_hex),
                                            "v4": row["v4"],
                                            "v5": row["v5"],
                                            "timestampMs": row["timestampMs"],
                                            "v6v7Equal": row["v6v7Equal"],
                                        }
                            elif seg.type == "knownDevlines":
                                parsed_dl = parse_known_devlines_tlvs(seg.raw_bytes)
                                if parsed_dl and parsed_dl.get("exactConsumed"):
                                    dl_map = parsed_dl.get("byId") or {}
                                    devlines_by_id.update(dl_map)
                                    arch_dl = self.archive_devlines.setdefault(archive_id, {})
                                    for dl_hex, dl_entry in dl_map.items():
                                        arch_dl[dl_hex] = {
                                            **dl_entry,
                                            "sourceArchive": filename,
                                            "sourceContainer": cname,
                                        }
                        for seg in unchunked.segments:
                            if seg.type == "pvcElement":
                                parsed_pvc = parse_pvc_element_tlvs(seg.raw_bytes)
                                if parsed_pvc and parsed_pvc.get("oid"):
                                    oid_h = parsed_pvc["oid"].lower()
                                    vid_h = (parsed_pvc.get("vid") or "").lower()
                                    if header_vset_dashed:
                                        parsed_pvc["headerVersionSetId"] = header_vset_dashed
                                    tail_ids = parsed_pvc.get("tailVersionSetIds") or []
                                    if tail_ids:
                                        parsed_pvc["r16MatchesHeader"] = bool(
                                            header_vset_hex and all(t == header_vset_hex for t in tail_ids)
                                        )
                                    mem = vset_by_oid_vid.get((oid_h, vid_h))
                                    if mem is not None:
                                        parsed_pvc["membership"] = mem
                                    if parsed_pvc.get("ownerVsIds"):
                                        resolved_dls = []
                                        unresolved_dls = []
                                        for r3 in parsed_pvc["ownerVsIds"]:
                                            if r3 in devlines_by_id:
                                                resolved_dls.append({**devlines_by_id[r3], "scope": "local"})
                                            else:
                                                unresolved_dls.append(format_uuid_dashed(r3))
                                        if resolved_dls:
                                            parsed_pvc["devlines"] = resolved_dls
                                        if unresolved_dls:
                                            parsed_pvc["unresolvedOwnerVsIds"] = unresolved_dls
                                    if vid_h:
                                        pvc_by_oid_vid[(oid_h, vid_h)] = parsed_pvc
                                    pvc_by_oid[oid_h] = parsed_pvc
                        if unchunked.report.model_elements_total > 0 and (
                            unchunked.report.model_elements_exact == unchunked.report.model_elements_total
                        ):
                            for seg in unchunked.segments:
                                if seg.type == "modelElement" and len(seg.raw_bytes) > 8:
                                    raw_xi_list.append(seg.raw_bytes[8:])
                            exact_extracted = True
                        elif unchunked.report.contiguous_segments:
                            # Valid container with 0 modelElement segments (e.g., empty delta)
                            exact_extracted = True
                    except Exception as exc:
                        warnings.append(f"{cname}: exact unchunk fallback ({exc})")

                if not exact_extracted:
                    cat_bytes, cat_off = find_catalog_bytes(cdata)
                    if cat_bytes is not None:
                        segs = parse_catalog_bytes(cat_bytes, csize, warnings)
                        seg_count = len(segs)
                        obj_segs = [s for s in segs if s.in_object_list and s.type == "modelElement"]
                        if obj_segs:
                            scan_start = min(s.offset for s in obj_segs)
                        else:
                            mgd = [s for s in segs if s.type == "modelGeneralData"]
                            scan_start = mgd[0].offset + mgd[0].length if mgd else 0
                        scan_end = cat_off
                    else:
                        scan_start, scan_end = 0, csize

                    scan_start = max(0, min(scan_start, csize))
                    scan_end = max(0, min(scan_end, csize))
                    raw_xi_list = scan_xi_objects_from_slice(cdata[scan_start:scan_end]) if scan_start < scan_end else []

                c_obj_count = 0
                for raw_xi in raw_xi_list:
                    root_elem = parse_xi_xml_safe(raw_xi)
                    if root_elem is None:
                        warnings.append(f"{cname}: could not parse an xiObj XML block")
                        continue
                    extracted = self._collect_xi_tree(root_elem, archive_id, filename, cname)
                    if pvc_by_oid or pvc_by_oid_vid:
                        for ex_obj in extracted:
                            norm_oid = normalize_uuid_hex(ex_obj.oid) or ex_obj.oid.replace("-", "").lower()
                            norm_vid = normalize_uuid_hex(ex_obj.vid) or ex_obj.vid.replace("-", "").lower()
                            if (norm_oid, norm_vid) in pvc_by_oid_vid:
                                ex_obj.pvc_info = pvc_by_oid_vid[(norm_oid, norm_vid)]
                            elif norm_oid in pvc_by_oid:
                                ex_obj.pvc_info = pvc_by_oid[norm_oid]
                    c_obj_count += len(extracted)
                    created_objects.extend(extracted)

                containers_summary.append({
                    "name": cname,
                    "kind": "delta" if cname.lower().endswith(".dlt") else "primary",
                    "bytes": csize,
                    "segments": seg_count,
                    "objects": c_obj_count,
                    "crcIntegrity": crc_report,
                })

        # Resolve cross-object Operation Mapping -> XI_TRAFO / TRAFO_JAR summary
        for obj in created_objects:
            self.objects[obj.id] = obj

        elapsed_ms = int((time.time() - started) * 1000)
        summary = self._build_archive_payload(archive_id, filename, len(raw_bytes), metadata_props,
                                              containers_summary, created_objects, warnings, elapsed_ms)
        self.archives[archive_id] = summary
        self.archive_bytes[archive_id] = raw_bytes
        return summary

    def simulate_mapping_object(
        self,
        object_id: str,
        source_xml: str,
        execute_java_udfs: bool = True,
    ) -> Dict[str, Any]:
        obj = self.objects.get(object_id)
        if obj is None:
            raise KeyError(f"Object not found: {object_id}")
        if not obj.mapping_data:
            raise ValueError(f"Object '{obj.name}' does not contain a Message Mapping payload.")
        return simulate_mapping(
            obj.mapping_data,
            source_xml=source_xml,
            execute_java_udfs=execute_java_udfs,
            java_bin=self.java_bin,
            javac_bin=self.javac_bin,
        )

    def remove_archive(self, archive_id: str) -> None:
        self.archives.pop(archive_id, None)
        self.archive_bytes.pop(archive_id, None)
        self.archive_devlines.pop(archive_id, None)
        to_del = [oid for oid, o in self.objects.items() if o.archive_id == archive_id]
        for oid in to_del:
            self.objects.pop(oid, None)

    def verify_archive(self, archive_id: str) -> Dict[str, Any]:
        raw = self.archive_bytes.get(archive_id)
        if raw is None:
            raise KeyError(f"Archive not found: {archive_id}")
        meta = self.archives.get(archive_id, {})
        return {
            "archiveId": archive_id,
            "fileName": meta.get("fileName", ""),
            **verify_tpz_bytes(raw),
        }

    def repack_archive(
        self,
        archive_id: str,
        replacements: Optional[List[Dict[str, str]]] = None,
        channel_patches: Optional[List[Dict[str, str]]] = None,
        sanitize: bool = False,
        include_header: bool = False,
    ) -> Tuple[str, bytes, Dict[str, Any]]:
        raw = self.archive_bytes.get(archive_id)
        if raw is None:
            raise KeyError(f"Archive not found: {archive_id}")
        orig_name = self.archives.get(archive_id, {}).get("fileName", "archive.tpz")
        stem = orig_name[:-4] if orig_name.lower().endswith(".tpz") else orig_name
        suffix = "_sanitized.tpz" if sanitize else "_repacked.tpz"
        out_bytes, summary = repack_tpz_bytes(
            raw,
            replacements=replacements,
            channel_patches=channel_patches,
            sanitize=sanitize,
            include_header=include_header,
        )
        return f"{stem}{suffix}", out_bytes, summary

    def _collect_xi_tree(self, root_elem: ET.Element, archive_id: str,
                         archive_name: str, container_name: str) -> List[StoredObject]:
        results: List[StoredObject] = []

        def walk(elem: ET.Element, depth: int, parent_oid: Optional[str]) -> None:
            obj = self._parse_single_xi(elem, archive_id, archive_name, container_name, depth, parent_oid)
            results.append(obj)
            next_parent = obj.oid or parent_oid
            for sub in list(elem):
                if local_name(sub.tag) == "xiObj":
                    walk(sub, depth + 1, next_parent)
                else:
                    walk_wrappers(sub, depth, next_parent)

        def walk_wrappers(node: ET.Element, depth: int, parent_oid: Optional[str]) -> None:
            for sub in list(node):
                if local_name(sub.tag) == "xiObj":
                    walk(sub, depth + 1, parent_oid)
                else:
                    walk_wrappers(sub, depth, parent_oid)

        walk(root_elem, 0, None)
        return results

    def _parse_single_xi(self, elem: ET.Element, archive_id: str, archive_name: str,
                         container_name: str, depth: int, parent_oid: Optional[str]) -> StoredObject:
        type_id = oid = vid = name = namespace = swcv_caption = swcv_guid = ""
        modif_by = modif_at = owner = ""
        links: List[Dict[str, Any]] = []

        idinfo = child(elem, "idInfo")
        party_val = service_val = ""
        if idinfo is not None:
            vid = idinfo.get("VID", "")
            vc = child(idinfo, "vc")
            if vc is not None:
                swcv_guid = vc.get("swcGuid", "")
                swcv_caption = vc.get("caption", "")
            key = child(idinfo, "key")
            if key is not None:
                type_id = key.get("typeID", "")
                oid = key.get("oid", "")
                raw_elems = [(c.text or "").strip() for c in list(key) if local_name(c.tag) == "elem"]
                if type_id == "Channel" and len(raw_elems) >= 3:
                    party_val, service_val, name = raw_elems[0], raw_elems[1], raw_elems[2]
                    namespace = f"{party_val} / {service_val}".strip(" /")
                elif type_id == "Service" and len(raw_elems) >= 2:
                    party_val, name = raw_elems[0], raw_elems[1]
                    namespace = party_val or "Business Component"
                elif type_id in ("AllInOne", "IntegratedConfiguration", "SenderAgreement", "ReceiverDetermination", "InterfaceDetermination", "ReceiverAgreement") and len(raw_elems) >= 4:
                    snd_comp = raw_elems[1] or raw_elems[0] or "*"
                    # SAP Directory key order: [SenderParty, SenderService, InterfaceNamespace, InterfaceName, ReceiverParty, ReceiverService]
                    if raw_elems[2].startswith(("http://", "urn:")) or "/" in raw_elems[2]:
                        if_ns, if_name = raw_elems[2], raw_elems[3] or "Interface"
                    else:
                        if_name, if_ns = raw_elems[2] or "Interface", raw_elems[3]
                    name = f"{snd_comp} → {if_name}"
                    namespace = if_ns or "Directory"
                else:
                    non_empty = [x for x in raw_elems if x]
                    if non_empty:
                        name = non_empty[0]
                    if len(non_empty) > 1:
                        namespace = non_empty[1]

        generic = child(elem, "generic")
        if generic is not None:
            adm = child(generic, "admInf")
            if adm is not None:
                modif_by = child_text(adm, "modifBy")
                modif_at = child_text(adm, "modifAt")
                owner = child_text(adm, "owner")
            lnks = child(generic, "lnks")
            if lnks is not None:
                for lr in list(lnks):
                    if local_name(lr.tag) != "lnkRole":
                        continue
                    for lk in list(lr):
                        if local_name(lk.tag) != "lnk":
                            continue
                        k = child(lk, "key")
                        if k is None:
                            continue
                        t_type = k.get("typeID", "")
                        raw_l_elems = [(c.text or "").strip() for c in list(k) if local_name(c.tag) == "elem"]
                        non_empty_l = [x for x in raw_l_elems if x]
                        if t_type == "Channel" and len(raw_l_elems) >= 3:
                            t_name = raw_l_elems[2]
                            t_ns = " / ".join(x for x in raw_l_elems[:2] if x)
                        elif t_type == "Service" and len(raw_l_elems) >= 2:
                            t_name = raw_l_elems[1]
                            t_ns = raw_l_elems[0]
                        else:
                            t_name = non_empty_l[0] if non_empty_l else ""
                            t_ns = non_empty_l[1] if len(non_empty_l) > 1 else ""
                        links.append({
                            "role": lr.get("role", ""),
                            "kpos": lr.get("kpos", ""),
                            "rMode": lk.get("rMode", ""),
                            "targetType": t_type,
                            "targetOid": k.get("oid", ""),
                            "targetName": t_name,
                            "targetNamespace": t_ns,
                            "elems": non_empty_l,
                        })

        texts = extract_multilingual_texts(elem)
        content_el = child(elem, "content")
        content_bytes = ET.tostring(content_el, encoding="utf-8") if content_el is not None else b""
        resources = unpack_blobs_in_memory(content_bytes) if content_bytes else []

        mapping_data = None
        for res in resources:
            if res.kind == "mappingtool":
                mapping_data = parse_mappingtool_xml(res.data)
                break

        channel_data = parse_channel_details(
            content_el, links=links, party=party_val, service=service_val, channel_name=name
        ) if type_id == "Channel" or (
            content_el is not None and any(local_name(x.tag) == "Channel" for x in content_el.iter())
        ) else None

        process_steps = parse_process_steps(content_el, links) if type_id == "process" else []

        raw_key = f"{archive_id}:{container_name}:{type_id}:{oid}:{vid}:{name}:{namespace}:{depth}:{uuid.uuid4().hex[:6]}"
        obj_id = hashlib.sha1(raw_key.encode("utf-8", "replace")).hexdigest()[:16]

        return StoredObject(
            id=obj_id,
            archive_id=archive_id,
            archive_name=archive_name,
            container_name=container_name,
            type_id=type_id or "UNKNOWN",
            oid=oid,
            vid=vid,
            name=name or oid or "Unnamed",
            namespace=namespace,
            swcv_caption=swcv_caption,
            swcv_guid=swcv_guid,
            modif_by=modif_by,
            modif_at=modif_at,
            owner=owner,
            depth=depth,
            parent_oid=parent_oid,
            links=links,
            texts=texts,
            content_xml_bytes=to_pretty_xml_str(content_el).encode("utf-8") if content_el is not None else b"",
            resources=resources,
            mapping_data=mapping_data,
            channel_data=channel_data,
            process_steps=process_steps,
        )

    def _serialize_object_summary(self, o: StoredObject) -> Dict[str, Any]:
        class_files = [r.path for r in o.resources if r.kind == "class"]
        schema_files = [{"path": r.path, "kind": r.kind, "size": r.size}
                        for r in o.resources if r.kind in ("xsd", "wsdl", "xsl", "xml")]
        return {
            "id": o.id,
            "archiveId": o.archive_id,
            "archiveName": o.archive_name,
            "containerName": o.container_name,
            "typeId": o.type_id,
            "oid": o.oid,
            "vid": o.vid,
            "name": o.name,
            "namespace": o.namespace,
            "swcv": o.swcv_caption,
            "modifBy": o.modif_by,
            "modifAt": o.modif_at,
            "owner": o.owner,
            "depth": o.depth,
            "parentOid": o.parent_oid,
            "linkCount": len(o.links),
            "textCount": len(o.texts),
            "fieldMappingCount": len(o.mapping_data["fieldMappings"]) if o.mapping_data else 0,
            "udfCount": len(o.mapping_data["udfs"]) if o.mapping_data else 0,
            "classCount": len(class_files),
            "schemaCount": len(schema_files),
            "hasChannel": o.channel_data is not None,
            "adapterType": o.channel_data["adapterType"] if o.channel_data else "",
            "direction": o.channel_data["direction"] if o.channel_data else "",
        }

    def get_object_detail(self, obj_id: str) -> Dict[str, Any]:
        o = self.objects.get(obj_id)
        if not o:
            raise KeyError(f"Object not found: {obj_id}")

        textual_resources = []
        class_resources = []
        for idx, r in enumerate(o.resources):
            if r.kind == "class":
                class_resources.append({
                    "index": idx,
                    "path": r.path,
                    "size": r.size,
                })
            elif r.kind in ("xsd", "wsdl", "xsl", "xml", "mappingtool"):
                textual_resources.append({
                    "index": idx,
                    "path": r.path,
                    "kind": r.kind,
                    "size": r.size,
                    "content": r.data.decode("utf-8", "replace"),
                })

        pvc_out = o.pvc_info
        if pvc_out and pvc_out.get("unresolvedOwnerVsIds"):
            cross_dls: List[Dict[str, Any]] = []
            still_unresolved: List[str] = []
            for dashed_id in pvc_out["unresolvedOwnerVsIds"]:
                norm_id = normalize_uuid_hex(dashed_id)
                found_entry = None
                for other_aid, dl_map in self.archive_devlines.items():
                    if other_aid != o.archive_id and norm_id in dl_map:
                        found_entry = {**dl_map[norm_id], "scope": "workspace"}
                        break
                if found_entry is not None:
                    cross_dls.append(found_entry)
                else:
                    still_unresolved.append(dashed_id)
            if cross_dls:
                pvc_out = {
                    **pvc_out,
                    "crossArchiveDevlines": cross_dls,
                    "unresolvedOwnerVsIds": still_unresolved,
                }

        return {
            **self._serialize_object_summary(o),
            "links": o.links,
            "texts": o.texts,
            "contentXml": o.content_xml_bytes.decode("utf-8", "replace"),
            "mapping": o.mapping_data,
            "channel": o.channel_data,
            "processSteps": o.process_steps,
            "textualResources": textual_resources,
            "classResources": class_resources,
            "pvcInfo": pvc_out,
        }

    def decompile_class(self, obj_id: str, resource_index: int) -> Dict[str, Any]:
        o = self.objects.get(obj_id)
        if not o:
            raise KeyError(f"Object not found: {obj_id}")
        if resource_index < 0 or resource_index >= len(o.resources):
            raise IndexError(f"Invalid resource index: {resource_index}")
        res = o.resources[resource_index]
        cache_key = hashlib.sha1(res.data).hexdigest()
        if cache_key in self.class_cache:
            return self.class_cache[cache_key]

        cfr_java = ""
        javap_text = ""
        tmp_base = os.path.join(os.path.dirname(__file__), ".tmp_decompile")
        os.makedirs(tmp_base, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="tpz_cls_", dir=tmp_base) as tmp:
            cls_name = os.path.basename(res.path)
            if not cls_name.endswith(".class"):
                cls_name += ".class"
            cls_path = os.path.join(tmp, cls_name)
            with open(cls_path, "wb") as f:
                f.write(res.data)

            no_win = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            if self.java_bin and self.cfr_jar:
                try:
                    cfr_arg = self._to_tool_path(self.java_bin, self.cfr_jar)
                    cls_arg = self._to_tool_path(self.java_bin, cls_path)
                    cr = subprocess.run(
                        [self.java_bin, "-jar", cfr_arg, cls_arg],
                        capture_output=True,
                        timeout=45,
                        creationflags=no_win,
                    )
                    if cr.returncode == 0 and cr.stdout:
                        cfr_java = cr.stdout.decode("utf-8", "replace")
                except Exception as exc:
                    cfr_java = f"// CFR decompilation error: {exc}"

            if self.javap_bin:
                try:
                    cls_arg = self._to_tool_path(self.javap_bin, cls_path)
                    pr = subprocess.run(
                        [self.javap_bin, "-p", "-c", "-constants", cls_arg],
                        capture_output=True,
                        timeout=30,
                        creationflags=no_win,
                    )
                    if pr.returncode == 0 and pr.stdout:
                        javap_text = pr.stdout.decode("utf-8", "replace")
                except Exception as exc:
                    javap_text = f"// javap disassembly error: {exc}"

        result = {
            "path": res.path,
            "size": res.size,
            "cfrJava": cfr_java,
            "javapText": javap_text,
            "decompilerUsed": "cfr" if cfr_java and not cfr_java.startswith("// CFR") else ("javap" if javap_text else "none"),
        }
        self.class_cache[cache_key] = result
        return result

    def global_search(self, query: str, limit: int = 200) -> Dict[str, Any]:
        q = (query or "").strip().lower()
        if not q:
            return {"query": query, "objects": [], "fieldMappings": [], "udfs": [], "channels": [], "texts": []}

        matched_objects = []
        matched_fields = []
        matched_udfs = []
        matched_channels = []
        matched_texts = []

        for o in self.objects.values():
            if q in o.name.lower() or q in o.namespace.lower() or q in o.type_id.lower() or q in o.oid.lower():
                if len(matched_objects) < limit:
                    matched_objects.append(self._serialize_object_summary(o))

            if o.mapping_data:
                for fm in o.mapping_data["fieldMappings"]:
                    if (
                        q in fm["targetPath"].lower()
                        or q in fm["expression"].lower()
                        or any(q in s.lower() for s in fm["sources"])
                        or any(q in c.lower() for c in fm["constants"])
                        or any(q in u.lower() for u in fm["udfs"])
                    ):
                        if len(matched_fields) < limit:
                            matched_fields.append({
                                "objectId": o.id,
                                "mappingName": o.name,
                                "archiveName": o.archive_name,
                                **fm,
                            })
                for u in o.mapping_data["udfs"]:
                    if q in u["name"].lower() or q in u["javaCode"].lower():
                        if len(matched_udfs) < limit:
                            matched_udfs.append({
                                "objectId": o.id,
                                "mappingName": o.name,
                                "archiveName": o.archive_name,
                                "name": u["name"],
                                "key": u["key"],
                                "lineCount": u["lineCount"],
                            })

            if o.channel_data:
                for attr in o.channel_data["attributes"]:
                    if q in attr["name"].lower() or q in attr["value"].lower():
                        if len(matched_channels) < limit:
                            matched_channels.append({
                                "objectId": o.id,
                                "channelName": o.name,
                                "archiveName": o.archive_name,
                                "adapterType": o.channel_data["adapterType"],
                                "attributeName": attr["name"],
                                "attributeValue": attr["value"],
                            })

            for tx in o.texts:
                if q in tx["text"].lower() or q in tx["label"].lower():
                    if len(matched_texts) < limit:
                        matched_texts.append({
                            "objectId": o.id,
                            "objectName": o.name,
                            "typeId": o.type_id,
                            "archiveName": o.archive_name,
                            **tx,
                        })

        return {
            "query": query,
            "objects": matched_objects,
            "fieldMappings": matched_fields,
            "udfs": matched_udfs,
            "channels": matched_channels,
            "texts": matched_texts,
        }

    def _build_archive_payload(self, archive_id: str, filename: str, size_bytes: int,
                               metadata_props: Dict[str, str], containers: List[Dict[str, Any]],
                               objs: List[StoredObject], warnings: List[str], elapsed_ms: int) -> Dict[str, Any]:
        type_counts: Dict[str, int] = {}
        total_mappings = total_fields = total_udfs = total_classes = total_channels = total_xslts = 0
        for o in objs:
            type_counts[o.type_id] = type_counts.get(o.type_id, 0) + 1
            if o.mapping_data:
                total_mappings += 1
                total_fields += len(o.mapping_data["fieldMappings"])
                total_udfs += len(o.mapping_data["udfs"])
            if o.channel_data:
                total_channels += 1
            for r in o.resources:
                if r.kind == "class":
                    total_classes += 1
                elif r.kind == "xsl":
                    total_xslts += 1

        # Migration Complexity Score heuristic for SAP PO -> Integration Suite (CPI)
        complexity_points = (
            total_mappings * 2
            + total_udfs * 4
            + total_classes * 5
            + total_xslts * 3
            + total_channels * 2
            + type_counts.get("process", 0) * 12  # ccBPM requires redesign in CPI
        )
        if complexity_points == 0:
            tier = "Low"
        elif complexity_points < 25:
            tier = "Low"
        elif complexity_points < 100:
            tier = "Medium"
        elif complexity_points < 300:
            tier = "High"
        else:
            tier = "Enterprise / Very High"

        return {
            "archiveId": archive_id,
            "fileName": filename,
            "sizeBytes": size_bytes,
            "parsedInMs": elapsed_ms,
            "metadata": metadata_props,
            "containers": containers,
            "warnings": warnings,
            "stats": {
                "totalObjects": len(objs),
                "typeCounts": type_counts,
                "messageMappings": total_mappings,
                "fieldMappings": total_fields,
                "udfs": total_udfs,
                "javaClasses": total_classes,
                "xsltFiles": total_xslts,
                "channels": total_channels,
                "ccBpmProcesses": type_counts.get("process", 0),
                "complexityScore": complexity_points,
                "complexityTier": tier,
            },
            "objects": [self._serialize_object_summary(o) for o in objs],
        }
