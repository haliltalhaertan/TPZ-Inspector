#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SAP PI/PO Offline Message Mapping Simulator & "Display Queue" Engine.

Built on documented SAP PI/PO tf7 / tf3 runtime interoperability interfaces:
  - ResultList.SUPPRESS = "_sUpPresSeD_"
  - ResultList.CC       = "__cC_"
  - ResultList.XSI_NIL  = "_!xSi#NiL$_"
  - ResultList.clear()  = void method

Evaluates Message Mapping AST (from mappingtool.xml graphNodes/graphEdges + UDF definitions)
against a user-provided Source XML document, supports ~45 standard SAP ESR functions,
and compiles + executes embedded Java UDFs (value / context / queue cache types) on the
local JVM (`javac` + `java`) using an embedded SAP tf7 + tf3 + mapping.api Java shim!
"""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple

RESULT_SUPPRESS = "_sUpPresSeD_"
RESULT_CC = "__cC_"
RESULT_XSI_NIL = "_!xSi#NiL$_"

IS_WINDOWS = os.name == "nt"
SUBPROC_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WINDOWS else 0


# ---------------------------------------------------------------------------
# Clean-Room Interoperability Java Stubs (tf7 + tf3 + mapping.api)
# ---------------------------------------------------------------------------
JAVA_SHIM_SOURCES: Dict[str, str] = {
    "com/sap/aii/mappingtool/tf7/rt/ResultList.java": """package com.sap.aii.mappingtool.tf7.rt;
import java.util.*;
public interface ResultList {
    String SUPPRESS = "_sUpPresSeD_";
    String CC = "__cC_";
    String XSI_NIL = "_!xSi#NiL$_";
    void addValue(Object value);
    void addContextChange();
    void addSuppress();
    void clear();
}
""",
    "com/sap/aii/mappingtool/tf7/rt/ResultListImpl.java": """package com.sap.aii.mappingtool.tf7.rt;
import java.util.*;
public class ResultListImpl implements ResultList, com.sap.aii.mappingtool.tf3.rt.ResultList {
    public final List<String> items = new ArrayList<>();
    public void addValue(Object value) {
        if (value == null) items.add(SUPPRESS);
        else items.add(String.valueOf(value));
    }
    public void addValue(String value) {
        if (value == null) items.add(SUPPRESS);
        else items.add(value);
    }
    public void addContextChange() { items.add(CC); }
    public void addSuppress() { items.add(SUPPRESS); }
    public void clear() { items.clear(); }
}
""",
    "com/sap/aii/mappingtool/tf7/rt/MappingTrace.java": """package com.sap.aii.mappingtool.tf7.rt;
public interface MappingTrace {
    void addInfo(String msg);
    void addWarning(String msg);
    void addDebugMessage(String msg);
}
""",
    "com/sap/aii/mappingtool/tf7/rt/GlobalContainer.java": """package com.sap.aii.mappingtool.tf7.rt;
import java.util.*;
public interface GlobalContainer {
    Object getParameter(String key);
    void setParameter(String key, Object value);
    Map<String, Object> getParameters();
}
""",
    "com/sap/aii/mappingtool/tf7/rt/Container.java": """package com.sap.aii.mappingtool.tf7.rt;
import java.util.*;
import com.sap.aii.mapping.api.*;
public interface Container {
    GlobalContainer getGlobalContainer();
    AbstractTrace getTrace();
    Map<String, Object> getTransformationParameters();
    Map<String, Object> getInputHeader();
    Map<String, Object> getInputParameters();
}
""",
    "com/sap/aii/mapping/api/AbstractTrace.java": """package com.sap.aii.mapping.api;
import com.sap.aii.mappingtool.tf7.rt.MappingTrace;
public abstract class AbstractTrace implements MappingTrace {
    public abstract void addInfo(String msg);
    public abstract void addWarning(String msg);
    public abstract void addDebugMessage(String msg);
    public void addDebugMessage(String msg, Throwable t) { addDebugMessage(msg + ": " + t); }
}
""",
    "com/sap/aii/mapping/api/DynamicConfigurationKey.java": """package com.sap.aii.mapping.api;
import java.util.Objects;
public class DynamicConfigurationKey {
    public final String namespace;
    public final String name;
    private DynamicConfigurationKey(String ns, String nm) { this.namespace = ns; this.name = nm; }
    public static DynamicConfigurationKey create(String ns, String nm) { return new DynamicConfigurationKey(ns, nm); }
    public String getNamespace() { return namespace; }
    public String getName() { return name; }
    public boolean equals(Object o) {
        if (!(o instanceof DynamicConfigurationKey)) return false;
        DynamicConfigurationKey k = (DynamicConfigurationKey) o;
        return Objects.equals(namespace, k.namespace) && Objects.equals(name, k.name);
    }
    public int hashCode() { return Objects.hash(namespace, name); }
}
""",
    "com/sap/aii/mapping/api/DynamicConfiguration.java": """package com.sap.aii.mapping.api;
import java.util.*;
public class DynamicConfiguration {
    private final Map<DynamicConfigurationKey, String> map = new HashMap<>();
    public String get(DynamicConfigurationKey key) { return map.get(key); }
    public String put(DynamicConfigurationKey key, String val) { return map.put(key, val); }
    public String remove(DynamicConfigurationKey key) { return map.remove(key); }
    public boolean containsKey(DynamicConfigurationKey key) { return map.containsKey(key); }
    public Iterator<DynamicConfigurationKey> getKeys() { return map.keySet().iterator(); }
}
""",
    "com/sap/aii/mapping/api/StreamTransformationConstants.java": """package com.sap.aii.mapping.api;
public interface StreamTransformationConstants {
    String DYNAMIC_CONFIGURATION = "DynamicConfiguration";
    String MESSAGE_ID = "MessageId";
    String SENDER_SERVICE = "SenderService";
    String RECEIVER_SERVICE = "ReceiverService";
    String INTERFACE = "Interface";
    String INTERFACE_NAMESPACE = "InterfaceNamespace";
}
""",
    "com/sap/aii/mapping/api/StreamTransformationException.java": """package com.sap.aii.mapping.api;
public class StreamTransformationException extends Exception {
    public StreamTransformationException(String msg) { super(msg); }
    public StreamTransformationException(String msg, Throwable cause) { super(msg, cause); }
}
""",
    "com/sap/aii/mappingtool/tf3/rt/ResultList.java": """package com.sap.aii.mappingtool.tf3.rt;
public interface ResultList extends com.sap.aii.mappingtool.tf7.rt.ResultList {
    void addValue(String value);
}
""",
    "com/sap/aii/mappingtool/tf3/rt/Container.java": """package com.sap.aii.mappingtool.tf3.rt;
public interface Container extends com.sap.aii.mappingtool.tf7.rt.Container {}
""",
    "com/sap/aii/mappingtool/tf3/rt/GlobalContainer.java": """package com.sap.aii.mappingtool.tf3.rt;
public interface GlobalContainer extends com.sap.aii.mappingtool.tf7.rt.GlobalContainer {}
""",
    "com/sap/aii/mappingtool/tf7/rt/SimContainerImpl.java": """package com.sap.aii.mappingtool.tf7.rt;
import java.util.*;
import com.sap.aii.mapping.api.*;
public class SimContainerImpl implements Container, GlobalContainer {
    private final Map<String, Object> globalParams = new HashMap<>();
    private final Map<String, Object> transParams = new HashMap<>();
    public final List<String[]> traces = new ArrayList<>();
    private final AbstractTrace trace = new AbstractTrace() {
        public void addInfo(String msg) { traces.add(new String[]{"INFO", String.valueOf(msg)}); }
        public void addWarning(String msg) { traces.add(new String[]{"WARN", String.valueOf(msg)}); }
        public void addDebugMessage(String msg) { traces.add(new String[]{"DEBUG", String.valueOf(msg)}); }
    };
    public SimContainerImpl() {
        transParams.put(StreamTransformationConstants.DYNAMIC_CONFIGURATION, new DynamicConfiguration());
        transParams.put(StreamTransformationConstants.MESSAGE_ID, "SIM-0000-0000");
        transParams.put(StreamTransformationConstants.SENDER_SERVICE, "SIM_SENDER");
        transParams.put(StreamTransformationConstants.RECEIVER_SERVICE, "SIM_RECEIVER");
    }
    public GlobalContainer getGlobalContainer() { return this; }
    public AbstractTrace getTrace() { return trace; }
    public Map<String, Object> getTransformationParameters() { return transParams; }
    public Map<String, Object> getInputHeader() { return transParams; }
    public Map<String, Object> getInputParameters() { return transParams; }
    public Object getParameter(String key) { return globalParams.get(key); }
    public void setParameter(String key, Object value) { globalParams.put(key, value); }
    public Map<String, Object> getParameters() { return globalParams; }
}
""",
}


# Persistent temp cache dir for compiled shims & UDF harnesses
_SHIM_CLASSES_DIR: Optional[str] = None
_UDF_CACHE: Dict[str, Dict[str, Any]] = {}


def _ensure_shim_compiled(javac_bin: str) -> Optional[str]:
    global _SHIM_CLASSES_DIR
    if _SHIM_CLASSES_DIR and os.path.isdir(_SHIM_CLASSES_DIR):
        return _SHIM_CLASSES_DIR
    base = os.path.join(tempfile.gettempdir(), "tpz_inspector_java_shim_v2")
    src_dir = os.path.join(base, "src")
    cls_dir = os.path.join(base, "classes")
    marker = os.path.join(cls_dir, "com", "sap", "aii", "mappingtool", "tf7", "rt", "SimContainerImpl.class")
    if os.path.isfile(marker):
        _SHIM_CLASSES_DIR = cls_dir
        return cls_dir
    os.makedirs(src_dir, exist_ok=True)
    os.makedirs(cls_dir, exist_ok=True)
    java_files: List[str] = []
    for rel, code in JAVA_SHIM_SOURCES.items():
        full = os.path.join(src_dir, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as fp:
            fp.write(code)
        java_files.append(full)
    proc = subprocess.run(
        [javac_bin, "-encoding", "UTF-8", "-d", cls_dir] + java_files,
        capture_output=True,
        text=True,
        timeout=20,
        creationflags=SUBPROC_FLAGS,
    )
    if proc.returncode != 0:
        return None
    _SHIM_CLASSES_DIR = cls_dir
    return cls_dir


def _sanitize_ident(name: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_$]", "_", (name or "").strip())
    if not cleaned or cleaned[0].isdigit():
        cleaned = f"{fallback}_{cleaned}"
    return cleaned


def _compile_single_udf(
    udf: Dict[str, Any],
    javac_bin: str,
    shim_dir: str,
) -> Dict[str, Any]:
    """Compile one SAP PI/PO UDF into a runnable harness class (cached by code hash)."""
    code = (udf.get("javaCode") or "").strip()
    cache_type = (udf.get("cacheType") or "value").strip().lower()
    args = udf.get("arguments") or []
    sig_key = hashlib.sha256(
        json.dumps({"name": udf.get("name"), "cache": cache_type, "args": args, "code": code}, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]

    if sig_key in _UDF_CACHE:
        return _UDF_CACHE[sig_key]

    if not code:
        entry = {"ok": False, "error": "Empty UDF Java code", "cacheType": cache_type, "dir": None, "className": None}
        _UDF_CACHE[sig_key] = entry
        return entry

    work_dir = os.path.join(tempfile.gettempdir(), f"tpz_udf_{sig_key}")
    cls_name = f"UdfRunner_{sig_key}"
    cls_file = os.path.join(work_dir, f"{cls_name}.class")
    if os.path.isfile(cls_file):
        entry = {"ok": True, "error": "", "cacheType": cache_type, "dir": work_dir, "className": cls_name}
        _UDF_CACHE[sig_key] = entry
        return entry

    os.makedirs(work_dir, exist_ok=True)
    uses_result_param = bool(re.search(r"\bresult\s*\.\s*(addValue|addSuppress|addContextChange|clear)\b", code))
    has_value_return = bool(re.search(r"\breturn\s+[^;\s]", code))
    is_array_mode = uses_result_param or (cache_type in ("context", "queue") and not has_value_return)

    # Build method parameter declarations
    param_decls: List[str] = []
    call_exprs: List[str] = []
    for i, a in enumerate(args):
        p_name = _sanitize_ident(a.get("name") or f"arg{i}", f"arg{i}")
        if is_array_mode:
            param_decls.append(f"String[] {p_name}")
            call_exprs.append(f"getArr(inputs, {i})")
        else:
            jtp = (a.get("javaType") or "String").strip()
            if jtp in ("int", "Integer"):
                param_decls.append(f"int {p_name}")
                call_exprs.append(f"parseIntSafe(getStr(inputs, {i}))")
            elif jtp in ("double", "Double", "float", "Float"):
                param_decls.append(f"double {p_name}")
                call_exprs.append(f"parseDoubleSafe(getStr(inputs, {i}))")
            elif jtp in ("boolean", "Boolean"):
                param_decls.append(f"boolean {p_name}")
                call_exprs.append(f"Boolean.parseBoolean(getStr(inputs, {i}))")
            else:
                param_decls.append(f"String {p_name}")
                call_exprs.append(f"getStr(inputs, {i})")

    if is_array_mode:
        param_decls.append("ResultList result")
        call_exprs.append("result")
    param_decls.append("Container container")
    call_exprs.append("container")

    method_header = (
        f"public void invoke({', '.join(param_decls)}) throws Exception"
        if is_array_mode
        else f"public String invoke({', '.join(param_decls)}) throws Exception"
    )
    exec_body = (
        f"runner.invoke({', '.join(call_exprs)});"
        if is_array_mode
        else f"String outVal = runner.invoke({', '.join(call_exprs)}); result.addValue(outVal);"
    )

    java_src = f"""import java.util.*;
import java.math.*;
import java.text.*;
import java.time.*;
import java.util.regex.*;
import com.sap.aii.mappingtool.tf7.rt.*;
import com.sap.aii.mapping.api.*;

public class {cls_name} {{
    {method_header} {{
{code}
    }}

    private static String getStr(List<List<String>> in, int idx) {{
        if (idx >= in.size() || in.get(idx).isEmpty()) return "";
        return in.get(idx).get(0);
    }}
    private static String[] getArr(List<List<String>> in, int idx) {{
        if (idx >= in.size()) return new String[0];
        List<String> l = in.get(idx);
        return l.toArray(new String[0]);
    }}
    private static int parseIntSafe(String s) {{
        try {{ return Integer.parseInt(s.trim()); }} catch (Exception e) {{ return 0; }}
    }}
    private static double parseDoubleSafe(String s) {{
        try {{ return Double.parseDouble(s.trim()); }} catch (Exception e) {{ return 0.0; }}
    }}

    public static void main(String[] args) throws Exception {{
        // Read protocol from stdin:
        // Line 0: number of arguments N
        // For each arg i: line with count K, followed by K lines of Base64 UTF-8 strings
        java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(System.in, "UTF-8"));
        String first = br.readLine();
        int nArgs = first == null ? 0 : Integer.parseInt(first.trim());
        List<List<String>> inputs = new ArrayList<>();
        Base64.Decoder dec = Base64.getDecoder();
        for (int i = 0; i < nArgs; i++) {{
            int k = Integer.parseInt(br.readLine().trim());
            List<String> list = new ArrayList<>(k);
            for (int j = 0; j < k; j++) {{
                String b64 = br.readLine();
                list.add(new String(dec.decode(b64 == null ? "" : b64.trim()), "UTF-8"));
            }}
            inputs.add(list);
        }}
        SimContainerImpl container = new SimContainerImpl();
        ResultListImpl result = new ResultListImpl();
        {cls_name} runner = new {cls_name}();
        {exec_body}
        Base64.Encoder enc = Base64.getEncoder();
        System.out.println("ITEMS:" + result.items.size());
        for (String it : result.items) {{
            System.out.println(enc.encodeToString((it == null ? ResultList.SUPPRESS : it).getBytes("UTF-8")));
        }}
        System.out.println("TRACES:" + container.traces.size());
        for (String[] tr : container.traces) {{
            System.out.println(tr[0] + "|" + enc.encodeToString(tr[1].getBytes("UTF-8")));
        }}
    }}
}}
"""
    src_path = os.path.join(work_dir, f"{cls_name}.java")
    with open(src_path, "w", encoding="utf-8") as fp:
        fp.write(java_src)

    proc = subprocess.run(
        [javac_bin, "-encoding", "UTF-8", "-cp", shim_dir, "-d", work_dir, src_path],
        capture_output=True,
        text=True,
        timeout=15,
        creationflags=SUBPROC_FLAGS,
    )
    if proc.returncode != 0:
        err_msg = (proc.stderr or proc.stdout or "javac compilation error").strip()
        entry = {"ok": False, "error": err_msg[:800], "cacheType": "context" if is_array_mode else "value", "dir": None, "className": None}
    else:
        entry = {"ok": True, "error": "", "cacheType": "context" if is_array_mode else "value", "dir": work_dir, "className": cls_name}

    _UDF_CACHE[sig_key] = entry
    return entry


def _run_compiled_udf(
    compiled: Dict[str, Any],
    arg_lists: List[List[str]],
    java_bin: str,
    shim_dir: str,
) -> Tuple[List[str], List[Tuple[str, str]], Optional[str]]:
    import base64

    lines = [str(len(arg_lists))]
    for arr in arg_lists:
        lines.append(str(len(arr)))
        for v in arr:
            lines.append(base64.b64encode(str(v).encode("utf-8")).decode("ascii"))
    stdin_payload = "\n".join(lines) + "\n"

    cp = f"{compiled['dir']}{os.pathsep}{shim_dir}"
    try:
        proc = subprocess.run(
            [java_bin, "-cp", cp, compiled["className"]],
            input=stdin_payload,
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=SUBPROC_FLAGS,
        )
    except subprocess.TimeoutExpired:
        return [RESULT_SUPPRESS], [], "UDF execution timed out (5s)"

    if proc.returncode != 0:
        return [RESULT_SUPPRESS], [], (proc.stderr or proc.stdout or "Runtime exception").strip()[:500]

    out_lines = [l.strip() for l in proc.stdout.splitlines() if l.strip()]
    items: List[str] = []
    traces: List[Tuple[str, str]] = []
    idx = 0
    if idx < len(out_lines) and out_lines[idx].startswith("ITEMS:"):
        n_items = int(out_lines[idx].split(":", 1)[1])
        idx += 1
        for _ in range(n_items):
            if idx < len(out_lines):
                items.append(base64.b64decode(out_lines[idx]).decode("utf-8", "replace"))
                idx += 1
    if idx < len(out_lines) and out_lines[idx].startswith("TRACES:"):
        n_tr = int(out_lines[idx].split(":", 1)[1])
        idx += 1
        for _ in range(n_tr):
            if idx < len(out_lines) and "|" in out_lines[idx]:
                lvl, b64 = out_lines[idx].split("|", 1)
                traces.append((lvl, base64.b64decode(b64).decode("utf-8", "replace")))
                idx += 1
    return (items if items else [RESULT_SUPPRESS]), traces, None


# ---------------------------------------------------------------------------
# Queue Helpers (SAP PI/PO Context Semantics)
# ---------------------------------------------------------------------------
def _split_contexts(queue: List[str]) -> List[List[str]]:
    ctxs: List[List[str]] = [[]]
    for v in queue:
        if v == RESULT_CC:
            ctxs.append([])
        else:
            ctxs[-1].append(v)
    return ctxs


def _join_contexts(ctxs: List[List[str]]) -> List[str]:
    out: List[str] = []
    for i, c in enumerate(ctxs):
        if i > 0:
            out.append(RESULT_CC)
        out.extend(c if c else [RESULT_SUPPRESS])
    return out if out else [RESULT_SUPPRESS]


def _local(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    if ":" in tag:
        return tag.split(":", 1)[1]
    return tag


def _norm_seg(seg: str) -> str:
    seg = re.sub(r"^(@?)[\w.-]+:", r"\1", seg)
    return re.sub(r"\[\d+\]$", "", seg)


def _extract_source_queue(root: ET.Element, src_path: str) -> List[str]:
    """
    Evaluate an SAP source XPath (e.g. /MT_OrderSource/Line/Matnr or /Root/Node/@attr)
    against the parsed Source XML DOM, emitting SAP contexts (CC) across repeating parents.
    """
    segs = [_norm_seg(s) for s in src_path.split("/") if s.strip()]
    if not segs:
        return [RESULT_SUPPRESS]

    # Match root element flexibly (if root matches segs[0], advance; else try matching from children)
    if _local(root.tag) == segs[0]:
        rem = segs[1:]
        current_groups: List[List[ET.Element]] = [[root]]
    else:
        rem = segs
        current_groups = [[root]]

    if not rem:
        val = (root.text or "").strip()
        return [val] if val else [RESULT_SUPPRESS]

    attr_name: Optional[str] = None
    if rem[-1].startswith("@"):
        attr_name = rem[-1][1:]
        rem = rem[:-1]

    for seg in rem:
        next_groups: List[List[ET.Element]] = []
        for grp in current_groups:
            for el in grp:
                matched = [c for c in list(el) if _local(c.tag) == seg]
                next_groups.append(matched)
        current_groups = next_groups

    ctxs: List[List[str]] = []
    for grp in current_groups:
        vals: List[str] = []
        for el in grp:
            if attr_name is not None:
                found = None
                for k, v in el.attrib.items():
                    if _local(k) == attr_name:
                        found = v
                        break
                vals.append(found if found is not None else RESULT_SUPPRESS)
            else:
                # Check xsi:nil
                is_nil = any(_local(k) == "nil" and v.lower() == "true" for k, v in el.attrib.items())
                if is_nil:
                    vals.append(RESULT_XSI_NIL)
                else:
                    vals.append((el.text or "").strip())
        ctxs.append(vals if vals else [RESULT_SUPPRESS])

    # Flatten single-element-per-parent repeating contexts nicely if >1 parent had children
    if not ctxs:
        return [RESULT_SUPPRESS]
    return _join_contexts(ctxs)


def _to_float(val: str) -> float:
    try:
        return float(str(val).replace(",", ".").strip())
    except Exception:
        return 0.0


def _to_bool(val: str) -> bool:
    return str(val).strip().lower() in ("true", "1", "yes")


def _align_value_op(args: List[List[str]], fn) -> List[str]:
    """Execute a scalar (value-level) SAP function across aligned queues, preserving CC and SUPPRESS."""
    if not args:
        return [fn([])]
    arg_ctxs = [_split_contexts(a) for a in args]
    max_ctxs = max(len(c) for c in arg_ctxs)
    out_ctxs: List[List[str]] = []
    for ci in range(max_ctxs):
        cur_lists = [c[ci] if ci < len(c) else c[-1] for c in arg_ctxs]
        max_len = max(len(l) for l in cur_lists)
        c_out: List[str] = []
        for vi in range(max_len):
            vals = [l[vi] if vi < len(l) else (l[-1] if l else RESULT_SUPPRESS) for l in cur_lists]
            if any(v == RESULT_SUPPRESS for v in vals):
                c_out.append(RESULT_SUPPRESS)
            else:
                c_out.append(str(fn(vals)))
        out_ctxs.append(c_out)
    return _join_contexts(out_ctxs)


def _eval_standard_func(
    fname: str,
    args: List[List[str]],
    params: Dict[str, str],
    warnings: List[str],
) -> List[str]:
    fl = fname.lower()

    if fl == "const":
        return [params.get("value", "")]

    if fl == "removecontexts":
        q = args[0] if args else []
        res = [v for v in q if v != RESULT_CC]
        return res if res else [RESULT_SUPPRESS]

    if fl == "collapsecontext":
        q = args[0] if args else []
        ctxs = _split_contexts(q)
        out = []
        for c in ctxs:
            first = next((x for x in c if x != RESULT_SUPPRESS), "")
            out.append(first)
        return out if out else [RESULT_SUPPRESS]

    if fl == "splitbyvalue":
        q = args[0] if args else []
        mode = (params.get("type") or params.get("value") or "Each value").lower()
        out: List[str] = []
        prev: Optional[str] = None
        for v in q:
            if v == RESULT_CC:
                if out and out[-1] != RESULT_CC:
                    out.append(RESULT_CC)
                prev = None
                continue
            if "change" in mode:
                if prev is not None and v != prev:
                    out.append(RESULT_CC)
                out.append(v)
                prev = v
            elif "empty" in mode:
                if v == "":
                    out.append(RESULT_CC)
                else:
                    out.append(v)
            else:
                if out and out[-1] != RESULT_CC:
                    out.append(RESULT_CC)
                out.append(v)
        return out if out else [RESULT_SUPPRESS]

    if fl == "useoneasmany":
        # arg0 = single value per context, arg1 = count template, arg2 = context template
        if len(args) < 3:
            return args[0] if args else [RESULT_SUPPRESS]
        v_list = [v for v in args[0] if v != RESULT_CC and v != RESULT_SUPPRESS]
        c1 = _split_contexts(args[1])
        c2 = _split_contexts(args[2])
        out_ctxs: List[List[str]] = []
        v_idx = 0
        for ci, ctx in enumerate(c2):
            src_val = v_list[min(v_idx, len(v_list) - 1)] if v_list else RESULT_SUPPRESS
            cnt = len(c1[ci]) if ci < len(c1) else len(ctx)
            out_ctxs.append([src_val] * max(1, cnt))
            if v_idx + 1 < len(v_list):
                v_idx += 1
        return _join_contexts(out_ctxs)

    if fl == "exists":
        q = args[0] if args else []
        ctxs = _split_contexts(q)
        return _join_contexts([["true" if any(x != RESULT_SUPPRESS for x in c) else "false"] for c in ctxs])

    if fl == "createif":
        q = args[0] if args else []
        return [("" if _to_bool(v) else RESULT_SUPPRESS) if v != RESULT_CC else RESULT_CC for v in q]

    if fl == "mapwithdefault":
        q = args[0] if args else []
        dflt = params.get("default", params.get("value", ""))
        ctxs = _split_contexts(q)
        return _join_contexts([[dflt] if all(x == RESULT_SUPPRESS for x in c) else c for c in ctxs])

    if fl == "copyvalue":
        q = args[0] if args else []
        pos = int(_to_float(params.get("position", params.get("index", "0"))))
        vals = [v for v in q if v != RESULT_CC and v != RESULT_SUPPRESS]
        return [vals[pos]] if 0 <= pos < len(vals) else [RESULT_SUPPRESS]

    if fl == "count":
        q = args[0] if args else []
        return _join_contexts([[str(sum(1 for x in c if x != RESULT_SUPPRESS))] for c in _split_contexts(q)])

    if fl == "sum":
        q = args[0] if args else []
        return _join_contexts([[str(sum(_to_float(x) for x in c if x != RESULT_SUPPRESS))] for c in _split_contexts(q)])

    if fl == "average":
        q = args[0] if args else []
        out_c = []
        for c in _split_contexts(q):
            nums = [_to_float(x) for x in c if x != RESULT_SUPPRESS]
            out_c.append([str(sum(nums) / len(nums)) if nums else "0"])
        return _join_contexts(out_c)

    if fl == "index":
        q = args[0] if args else []
        init = int(_to_float(params.get("initialValue", "1")))
        step = int(_to_float(params.get("increment", "1")))
        out_c = []
        for c in _split_contexts(q):
            cur = init
            res_c = []
            for x in c:
                if x == RESULT_SUPPRESS:
                    res_c.append(RESULT_SUPPRESS)
                else:
                    res_c.append(str(cur))
                    cur += step
            out_c.append(res_c)
        return _join_contexts(out_c)

    if fl == "concat":
        delim = params.get("delimeter", params.get("delimiter", ""))
        return _align_value_op(args, lambda vs: delim.join(vs))

    if fl == "substring":
        start = int(_to_float(params.get("from", params.get("start", "0"))))
        cnt = int(_to_float(params.get("count", params.get("length", "9999"))))
        return _align_value_op(args, lambda vs: vs[0][start : start + cnt] if vs else "")

    if fl in ("equalss", "equals"):
        return _align_value_op(args, lambda vs: "true" if len(vs) >= 2 and vs[0] == vs[1] else "false")

    if fl == "notequals":
        return _align_value_op(args, lambda vs: "true" if len(vs) >= 2 and vs[0] != vs[1] else "false")

    if fl == "equalsa":
        return _align_value_op(args, lambda vs: "true" if len(vs) >= 2 and abs(_to_float(vs[0]) - _to_float(vs[1])) < 1e-9 else "false")

    if fl == "less":
        return _align_value_op(args, lambda vs: "true" if len(vs) >= 2 and _to_float(vs[0]) < _to_float(vs[1]) else "false")

    if fl == "greater":
        return _align_value_op(args, lambda vs: "true" if len(vs) >= 2 and _to_float(vs[0]) > _to_float(vs[1]) else "false")

    if fl == "and":
        return _align_value_op(args, lambda vs: "true" if all(_to_bool(x) for x in vs) else "false")

    if fl == "or":
        return _align_value_op(args, lambda vs: "true" if any(_to_bool(x) for x in vs) else "false")

    if fl == "not":
        return _align_value_op(args, lambda vs: "false" if (vs and _to_bool(vs[0])) else "true")

    if fl in ("if", "ifs"):
        return _align_value_op(args, lambda vs: (vs[1] if len(vs) > 1 else "") if (vs and _to_bool(vs[0])) else (vs[2] if len(vs) > 2 else ""))

    if fl in ("ifwithoutelse", "ifwithoutelses"):
        return _align_value_op(args, lambda vs: (vs[1] if len(vs) > 1 else "") if (vs and _to_bool(vs[0])) else RESULT_SUPPRESS)

    if fl == "isnil":
        q = args[0] if args else []
        return [("true" if v == RESULT_XSI_NIL else "false") if v != RESULT_CC else RESULT_CC for v in q]

    if fl == "replacestring":
        return _align_value_op(args, lambda vs: vs[0].replace(vs[1], vs[2]) if len(vs) >= 3 else (vs[0] if vs else ""))

    if fl == "length":
        return _align_value_op(args, lambda vs: str(len(vs[0])) if vs else "0")

    if fl == "touppercase":
        return _align_value_op(args, lambda vs: vs[0].upper() if vs else "")

    if fl == "tolowercase":
        return _align_value_op(args, lambda vs: vs[0].lower() if vs else "")

    if fl == "trim":
        return _align_value_op(args, lambda vs: vs[0].strip() if vs else "")

    if fl == "startswith":
        return _align_value_op(args, lambda vs: "true" if len(vs) >= 2 and vs[0].startswith(vs[1]) else "false")

    if fl == "endswith":
        return _align_value_op(args, lambda vs: "true" if len(vs) >= 2 and vs[0].endswith(vs[1]) else "false")

    if fl in ("indexof", "indexof2"):
        return _align_value_op(args, lambda vs: str(vs[0].find(vs[1])) if len(vs) >= 2 else "-1")

    if fl == "add":
        return _align_value_op(args, lambda vs: str(_to_float(vs[0]) + _to_float(vs[1])) if len(vs) >= 2 else "0")

    if fl == "subtract":
        return _align_value_op(args, lambda vs: str(_to_float(vs[0]) - _to_float(vs[1])) if len(vs) >= 2 else "0")

    if fl == "multiply":
        return _align_value_op(args, lambda vs: str(_to_float(vs[0]) * _to_float(vs[1])) if len(vs) >= 2 else "0")

    if fl == "divide":
        return _align_value_op(args, lambda vs: str(_to_float(vs[0]) / _to_float(vs[1])) if len(vs) >= 2 and _to_float(vs[1]) != 0 else "0")

    if fl == "abs":
        return _align_value_op(args, lambda vs: str(abs(_to_float(vs[0]))) if vs else "0")

    if fl == "round":
        return _align_value_op(args, lambda vs: str(round(_to_float(vs[0]))) if vs else "0")

    if fl == "ceil":
        return _align_value_op(args, lambda vs: str(math.ceil(_to_float(vs[0]))) if vs else "0")

    if fl == "floor":
        return _align_value_op(args, lambda vs: str(math.floor(_to_float(vs[0]))) if vs else "0")

    if fl == "currentdate":
        fmt = params.get("format", "yyyy-MM-dd")
        now = datetime.datetime.now()
        py_fmt = fmt.replace("yyyy", "%Y").replace("MM", "%m").replace("dd", "%d").replace("HH", "%H").replace("mm", "%M").replace("ss", "%S")
        try:
            return [now.strftime(py_fmt)]
        except Exception:
            return [now.strftime("%Y-%m-%d")]

    if fl == "datetrans":
        return _align_value_op(args, lambda vs: vs[0] if vs else "")

    if fl == "formatnumber":
        return _align_value_op(args, lambda vs: f"{_to_float(vs[0]):.2f}" if vs else "0.00")

    if fl in ("fixvalues", "valuemapping"):
        if params:
            return _align_value_op(args, lambda vs: params.get(vs[0], params.get("default", vs[0])) if vs else "")
        return args[0] if args else [RESULT_SUPPRESS]

    warnings.append(f"Standard function '{fname}' approximated via passthrough")
    return args[0] if args else [RESULT_SUPPRESS]


# ---------------------------------------------------------------------------
# Target XML Builder (Context-Aware Sibling Alignment + Suppression + Attributes)
# ---------------------------------------------------------------------------
def _build_target_xml(target_queues: List[Dict[str, Any]]) -> str:
    """
    Build clean Target XML from evaluated target queues.
    Handles repeating container elements (e.g. /Root/Items/Item/Material + /Root/Items/Item/Quantity),
    suppresses `_sUpPresSeD_`, emits `xsi:nil="true"` for `_!xSi#NiL$_`, and sets `@attributes`.
    """
    # Group non-suppressed leaf values by path
    entries: List[Tuple[List[str], List[str]]] = []
    for tq in target_queues:
        segs = [_norm_seg(s) for s in tq["targetPath"].split("/") if s.strip()]
        if not segs:
            continue
        vals = [v for v in tq["queue"] if v != RESULT_CC and v != RESULT_SUPPRESS]
        if vals:
            entries.append((segs, vals))

    if not entries:
        return '<?xml version="1.0" encoding="UTF-8"?>\n<!-- All target queues evaluated to SUPPRESS or empty -->\n'

    root_tag = entries[0][0][0]
    root = ET.Element(root_tag)
    needs_xsi = False

    # Identify which container prefixes repeat (any descendant leaf has >1 value)
    repeat_counts: Dict[Tuple[str, ...], int] = {}
    for segs, vals in entries:
        if len(vals) > 1 and len(segs) >= 3:
            # Repeat the parent container of the leaf (e.g., ('MT_OrderTarget', 'Items', 'Item'))
            parent_key = tuple(segs[:-1])
            repeat_counts[parent_key] = max(repeat_counts.get(parent_key, 1), len(vals))

    # Map (prefix_tuple, instance_index) -> ET.Element
    elem_cache: Dict[Tuple[Tuple[str, ...], int], ET.Element] = {((root_tag,), 0): root}

    def get_or_create(path_tuple: Tuple[str, ...], inst_idx: int) -> ET.Element:
        key = (path_tuple, inst_idx)
        if key in elem_cache:
            return elem_cache[key]
        parent_tuple = path_tuple[:-1]
        parent_idx = inst_idx if parent_tuple in repeat_counts else 0
        parent_el = get_or_create(parent_tuple, parent_idx)
        el = ET.SubElement(parent_el, path_tuple[-1])
        elem_cache[key] = el
        return el

    for segs, vals in entries:
        is_attr = segs[-1].startswith("@")
        if is_attr:
            attr_nm = segs[-1][1:]
            parent_tuple = tuple(segs[:-1])
            for idx, val in enumerate(vals):
                el = get_or_create(parent_tuple, idx if parent_tuple in repeat_counts else 0)
                el.set(attr_nm, val)
            continue

        parent_tuple = tuple(segs[:-1])
        parent_repeats = parent_tuple in repeat_counts
        for idx, val in enumerate(vals):
            if parent_repeats:
                p_el = get_or_create(parent_tuple, idx)
                leaf = ET.SubElement(p_el, segs[-1])
            elif len(vals) > 1:
                p_el = get_or_create(parent_tuple, 0)
                leaf = ET.SubElement(p_el, segs[-1])
            else:
                leaf = get_or_create(tuple(segs), 0)

            if val == RESULT_XSI_NIL:
                needs_xsi = True
                leaf.set("xsi:nil", "true")
            else:
                leaf.text = val

    if needs_xsi:
        root.set("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance")

    try:
        ET.indent(root, space="  ")
    except Exception:
        pass
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode") + "\n"


# ---------------------------------------------------------------------------
# Public Entrypoint: simulate_mapping()
# ---------------------------------------------------------------------------
def simulate_mapping(
    mapping_payload: Dict[str, Any],
    source_xml: str,
    execute_java_udfs: bool = True,
    java_bin: Optional[str] = None,
    javac_bin: Optional[str] = None,
) -> Dict[str, Any]:
    t0 = time.perf_counter()
    warnings: List[str] = []
    traces: List[Dict[str, str]] = []
    udf_stats: Dict[str, Dict[str, Any]] = {}

    java_bin = java_bin or shutil.which("java")
    javac_bin = javac_bin or shutil.which("javac")

    try:
        src_root = ET.fromstring((source_xml or "").strip().encode("utf-8"))
    except ET.ParseError as exc:
        return {
            "ok": False,
            "error": f"Invalid Source XML: {exc}",
            "engine": "error",
            "durationMs": round((time.perf_counter() - t0) * 1000, 1),
            "targetXml": "",
            "targetQueues": [],
            "udfExecutions": [],
            "traces": [],
            "warnings": [],
        }

    # Index UDF definitions
    udfs = mapping_payload.get("udfs") or []
    udf_by_key: Dict[str, Dict[str, Any]] = {}
    for u in udfs:
        if u.get("key"):
            udf_by_key[u["key"].strip().lower()] = u
        if u.get("name"):
            udf_by_key[u["name"].strip().lower()] = u

    shim_dir: Optional[str] = None
    can_java = bool(execute_java_udfs and java_bin and javac_bin and udfs)
    if can_java:
        shim_dir = _ensure_shim_compiled(javac_bin)
        if not shim_dir:
            warnings.append("Failed to compile local Java interoperability shim; falling back to queue-only mode for UDFs.")
            can_java = False

    # Compile referenced UDFs once
    compiled_udfs: Dict[str, Dict[str, Any]] = {}

    def get_compiled_udf(u: Dict[str, Any]) -> Dict[str, Any]:
        uname = u.get("name") or u.get("key") or "udf"
        if uname not in compiled_udfs:
            if can_java and shim_dir and javac_bin:
                c = _compile_single_udf(u, javac_bin, shim_dir)
                compiled_udfs[uname] = c
                udf_stats[uname] = {
                    "name": uname,
                    "cacheType": c.get("cacheType") or u.get("cacheType") or "value",
                    "status": "ok" if c["ok"] else "compile_error",
                    "calls": 0,
                    "compiledWith": "javac (local tf7/tf3 shim)",
                    "error": c.get("error", ""),
                }
            else:
                compiled_udfs[uname] = {"ok": False, "error": "Java UDF execution disabled or javac unavailable", "cacheType": u.get("cacheType") or "value"}
                udf_stats[uname] = {
                    "name": uname,
                    "cacheType": u.get("cacheType") or "value",
                    "status": "skipped",
                    "calls": 0,
                    "compiledWith": "none",
                    "error": "Java UDF execution disabled or javac unavailable",
                }
        return compiled_udfs[uname]

    # Build graph lookup
    nodes_by_id = {n["id"]: n for n in (mapping_payload.get("graphNodes") or [])}
    incoming: Dict[str, List[Tuple[int, str]]] = {}
    for e in (mapping_payload.get("graphEdges") or []):
        lbl = e.get("label") or ""
        m = re.search(r"(\d+)", lbl)
        pin = int(m.group(1)) if m else 0
        incoming.setdefault(e["target"], []).append((pin, e["source"]))
    for tid in incoming:
        incoming[tid].sort(key=lambda x: x[0])

    # Index expressions by targetPath
    expr_by_target = {fm["targetPath"]: fm.get("expression", "") for fm in (mapping_payload.get("fieldMappings") or [])}

    used_java_any = False

    def eval_node(nid: str, steps_out: List[Dict[str, Any]], udfs_hit: List[str], depth: int = 0) -> List[str]:
        nonlocal used_java_any
        if depth > 45 or nid not in nodes_by_id:
            return [RESULT_SUPPRESS]
        node = nodes_by_id[nid]
        kind = node.get("kind")

        if kind == "source":
            q = _extract_source_queue(src_root, node.get("path") or "")
            steps_out.append({"nodeId": nid, "kind": "source", "label": node.get("label", ""), "path": node.get("path", ""), "queue": q})
            return q

        if kind == "const":
            q = [node.get("value", "")]
            steps_out.append({"nodeId": nid, "kind": "const", "label": node.get("label", ""), "queue": q})
            return q

        # Evaluate child inputs in pin order
        child_queues = [eval_node(src_id, steps_out, udfs_hit, depth + 1) for _, src_id in incoming.get(nid, [])]

        if kind == "target":
            q = child_queues[0] if child_queues else [RESULT_SUPPRESS]
            steps_out.append({"nodeId": nid, "kind": "target", "label": node.get("label", ""), "path": node.get("path", ""), "queue": q})
            return q

        if kind == "func":
            fname = node.get("function") or node.get("label") or "?"
            q = _eval_standard_func(fname, child_queues, node.get("parameters") or {}, warnings)
            steps_out.append({"nodeId": nid, "kind": "func", "label": fname, "queue": q})
            return q

        if kind == "udf":
            ukey = (node.get("udfKey") or node.get("label") or "").strip().lower()
            udf_def = udf_by_key.get(ukey)
            uname = (udf_def.get("name") if udf_def else None) or node.get("label") or ukey
            udfs_hit.append(uname)

            if not udf_def:
                warnings.append(f"UDF definition '{uname}' not found in mappingtool.xml")
                q = child_queues[0] if child_queues else [RESULT_SUPPRESS]
                steps_out.append({"nodeId": nid, "kind": "udf", "label": uname, "queue": q})
                return q

            compiled = get_compiled_udf(udf_def)
            if not compiled["ok"] or not java_bin or not shim_dir:
                q = child_queues[0] if child_queues else [RESULT_SUPPRESS]
                steps_out.append({"nodeId": nid, "kind": "udf", "label": uname, "queue": q, "error": compiled.get("error", "")})
                return q

            used_java_any = True
            ctype = compiled.get("cacheType", "value")
            if ctype == "value":
                # Execute once per aligned value across contexts
                arg_ctxs = [_split_contexts(a) for a in child_queues] if child_queues else [[["__NOARG__"]]]
                max_ctxs = max(len(c) for c in arg_ctxs)
                out_ctxs: List[List[str]] = []
                for ci in range(max_ctxs):
                    cur_lists = [c[ci] if ci < len(c) else c[-1] for c in arg_ctxs]
                    max_len = max(len(l) for l in cur_lists)
                    c_out: List[str] = []
                    for vi in range(max_len):
                        if child_queues:
                            vals = [l[vi] if vi < len(l) else (l[-1] if l else RESULT_SUPPRESS) for l in cur_lists]
                            if any(v == RESULT_SUPPRESS for v in vals):
                                c_out.append(RESULT_SUPPRESS)
                                continue
                            arg_payload = [[v] for v in vals]
                        else:
                            arg_payload = []
                        udf_stats[uname]["calls"] += 1
                        items, trs, rerr = _run_compiled_udf(compiled, arg_payload, java_bin, shim_dir)
                        for lvl, msg in trs:
                            traces.append({"level": lvl, "source": uname, "message": msg})
                        if rerr:
                            udf_stats[uname]["status"] = "runtime_error"
                            udf_stats[uname]["error"] = rerr
                            c_out.append(RESULT_SUPPRESS)
                        else:
                            c_out.extend(items)
                    out_ctxs.append(c_out)
                q = _join_contexts(out_ctxs)
            elif ctype == "queue":
                udf_stats[uname]["calls"] += 1
                items, trs, rerr = _run_compiled_udf(compiled, child_queues, java_bin, shim_dir)
                for lvl, msg in trs:
                    traces.append({"level": lvl, "source": uname, "message": msg})
                if rerr:
                    udf_stats[uname]["status"] = "runtime_error"
                    udf_stats[uname]["error"] = rerr
                    q = [RESULT_SUPPRESS]
                else:
                    q = items
            else:
                # context mode: invoke per context slice
                arg_ctxs = [_split_contexts(a) for a in child_queues] if child_queues else [[[]]]
                max_ctxs = max(len(c) for c in arg_ctxs)
                out_ctxs = []
                for ci in range(max_ctxs):
                    cur_lists = [c[ci] if ci < len(c) else c[-1] for c in arg_ctxs]
                    udf_stats[uname]["calls"] += 1
                    items, trs, rerr = _run_compiled_udf(compiled, cur_lists, java_bin, shim_dir)
                    for lvl, msg in trs:
                        traces.append({"level": lvl, "source": uname, "message": msg})
                    if rerr:
                        udf_stats[uname]["status"] = "runtime_error"
                        udf_stats[uname]["error"] = rerr
                        out_ctxs.append([RESULT_SUPPRESS])
                    else:
                        out_ctxs.append(items)
                q = _join_contexts(out_ctxs)

            steps_out.append({"nodeId": nid, "kind": "udf", "label": uname, "queue": q})
            return q

        return [RESULT_SUPPRESS]

    # Evaluate every target node in document order
    target_nodes = [n for n in (mapping_payload.get("graphNodes") or []) if n.get("kind") == "target"]
    target_queues: List[Dict[str, Any]] = []
    for tn in target_nodes:
        tpath = tn.get("path") or tn.get("targetGroup") or ""
        steps: List[Dict[str, Any]] = []
        udfs_hit: List[str] = []
        q = eval_node(tn["id"], steps, udfs_hit, 0)
        non_sup = sum(1 for v in q if v not in (RESULT_CC, RESULT_SUPPRESS))
        sup_cnt = sum(1 for v in q if v == RESULT_SUPPRESS)
        ctx_cnt = 1 + sum(1 for v in q if v == RESULT_CC)
        target_queues.append({
            "targetPath": tpath,
            "expression": expr_by_target.get(tpath, ""),
            "queue": q,
            "nonSuppressedCount": non_sup,
            "suppressedCount": sup_cnt,
            "contextCount": ctx_cnt,
            "udfsExecuted": list(dict.fromkeys(udfs_hit)),
            "stepQueues": steps,
        })

    target_xml = _build_target_xml(target_queues)
    return {
        "ok": True,
        "engine": "local-java-udf" if used_java_any else "python-queue",
        "durationMs": round((time.perf_counter() - t0) * 1000, 1),
        "targetXml": target_xml,
        "targetQueues": target_queues,
        "udfExecutions": list(udf_stats.values()),
        "traces": traces,
        "warnings": list(dict.fromkeys(warnings)),
    }
