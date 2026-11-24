#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SAP PI/PO .tpt / .dlt Binary Container Codec & Repacker.

Physical .tpt/.dlt layout:
  - Logical byte stream wrapped in 1 MiB (1,048,576 B) CRC-32/ISO-HDLC blocks:
      * Block 0 (bytes 0..1,048,575):   crc = zlib.crc32(blk0, 0) & 0xFFFFFFFF
        Starts with 8B magic (00 00 00 00 dc 35 8a 91) + 30B zero padding (38B preamble).
      * Block k >= 1:                   crc = zlib.crc32(blk_k, 0xDC358A91) & 0xFFFFFFFF
      * After every full 1 MiB logical block (when more logical data follows), an 8B checkpoint
        [4B 00000000][4B BE crc32] is inserted into the physical stream.
  - Logical stream segments (offset 38 .. eof_logical, contiguous with zero gaps):
      * header:          [8B BE (8 + len(xml))][4B 00000000][4B BE crc32(xml)][xml]
      * modelElement / metaModel-* / modelVersionSet / modelGeneralData:
                         [8B BE len(xml)][xml]
      * pvcElement / pvcVersionSet / pvcVersionSetSpecialization / knownDevlines:
                         raw binary TLV payload
  - End of physical file (starting at physical offset corresponding to eof_logical):
      * [4B 00000000][4B BE pre_catalog_crc32]
          - stream_crc mode (standard SAP PO exports): CRC32 of final logical block
          - cat_crc mode (catalog-CRC variant):        CRC32 of catalog XML
      * catalog XML (<?xml ...?><catalog>...</catalog>)
      * [8B BE eof_logical] (logical offset of catalog record)
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import struct
import sys
import zipfile
import zlib
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

TPT_MAGIC = b"\x00\x00\x00\x00\xdc\x35\x8a\x91"
CHUNK_SIZE = 1048576  # 1 MiB logical block size
CHUNK_SEED = 0xDC358A91
HEADER_PREAMBLE_LEN = 38

SEG_TAG_RE = re.compile(rb"<segment\b([^>]*)>")
SEG_ATTR_RE = re.compile(rb'([\w:.\-]+)\s*=\s*"([^"]*)"')
OFFSET_ATTR_RE = re.compile(rb'(\boffset\s*=\s*")(\d+)(")')
LENGTH_ATTR_RE = re.compile(rb'(\blength\s*=\s*")(\d+)(")')
HEADER_VSET_ID_RE = re.compile(rb'<[\w:.\-]*versionSet\b[^>]*\bid\s*=\s*"([^"]+)"', re.I)
HEX32_RE = re.compile(r"^[0-9a-f]{32}$")


def normalize_uuid_hex(raw_value: str) -> str:
    """Normalize a hyphenated or bare UUID string to 32 lowercase hex chars in network byte order."""
    if not raw_value:
        return ""
    cleaned = raw_value.strip().replace("-", "").lower()
    return cleaned if HEX32_RE.match(cleaned) else ""


def format_uuid_dashed(hex32: str) -> str:
    """Format a 32-hex network-byte-order UUID as canonical 8-4-4-4-12 hyphenated UUID."""
    h = normalize_uuid_hex(hex32)
    if not h:
        return hex32 or ""
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def extract_header_versionset_id(hdr_xml: bytes) -> str:
    """Extract header/versionSet@id as 32-hex network-byte-order UUID."""
    if not hdr_xml:
        return ""
    m = HEADER_VSET_ID_RE.search(hdr_xml)
    if not m:
        return ""
    return normalize_uuid_hex(m.group(1).decode("ascii", "replace"))

SENSITIVE_ATTR_HINTS = (
    "password", "passwd", "pwd", "secret", "token", "apikey", "api_key",
    "authorization", "user", "username", "proxyuser", "proxypassword",
)

URL_RE = re.compile(r"(https?|sftp|ftps?|ftp|jdbc:[a-z0-9:]+)://[^\s<\"']+", re.I)
IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")


@dataclass
class LogicalSegment:
    type: str
    offset: int
    length: int
    in_object_list: bool
    raw_bytes: bytes = field(repr=False)


@dataclass
class TptVerificationReport:
    valid_magic: bool
    verified: bool
    physical_bytes: int
    logical_bytes: int
    chunks_checked: int
    chunks_ok: int
    header_crc_ok: bool
    pre_catalog_crc_ok: bool
    cat_mode: str  # "stream_crc" | "cat_crc" | "mismatch"
    catalog_starts_xml: bool
    segment_count: int
    contiguous_segments: bool
    model_elements_exact: int
    model_elements_total: int
    pvc_elements_total: int = 0
    pvc_oid_consistent: int = 0
    cat_markers_checked: int = 0
    cat_markers_ok: int = 0
    header_version_set_id: str = ""
    vset_first_tlv_matches_header: Optional[bool] = None
    vset_second_tlv_id: str = ""
    vset_second_tlv_in_devlines: Optional[bool] = None
    vset_second_tlv_devline_label: str = ""
    vset_spec_code: Optional[int] = None
    vset_spec_matches_header: Optional[bool] = None
    vset_membership_rows: int = 0
    vset_membership_matches_header: int = 0
    vset_membership_joined_pvc: int = 0
    pvc_r16_total: int = 0
    pvc_r16_matches_header: int = 0
    known_devlines_count: int = 0
    pvc_r3_total: int = 0
    pvc_r3_resolved_devlines: int = 0
    pvc_r3_unresolved_unique: int = 0
    pvc_r3_unresolved_ids: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "validMagic": self.valid_magic,
            "verified": self.verified,
            "physicalBytes": self.physical_bytes,
            "logicalBytes": self.logical_bytes,
            "chunksChecked": self.chunks_checked,
            "chunksOk": self.chunks_ok,
            "headerCrcOk": self.header_crc_ok,
            "preCatalogCrcOk": self.pre_catalog_crc_ok,
            "catMode": self.cat_mode,
            "catalogStartsXml": self.catalog_starts_xml,
            "segmentCount": self.segment_count,
            "contiguousSegments": self.contiguous_segments,
            "modelElementsExact": self.model_elements_exact,
            "modelElementsTotal": self.model_elements_total,
            "pvcElementsTotal": self.pvc_elements_total,
            "pvcOidConsistent": self.pvc_oid_consistent,
            "catMarkersChecked": self.cat_markers_checked,
            "catMarkersOk": self.cat_markers_ok,
            "headerVersionSetId": self.header_version_set_id,
            "vsetFirstTlvMatchesHeader": self.vset_first_tlv_matches_header,
            "vsetSecondTlvId": self.vset_second_tlv_id,
            "vsetSecondTlvInDevlines": self.vset_second_tlv_in_devlines,
            "vsetSecondTlvDevlineLabel": self.vset_second_tlv_devline_label,
            "vsetSpecCode": self.vset_spec_code,
            "vsetSpecMatchesHeader": self.vset_spec_matches_header,
            "vsetMembershipRows": self.vset_membership_rows,
            "vsetMembershipMatchesHeader": self.vset_membership_matches_header,
            "vsetMembershipJoinedPvc": self.vset_membership_joined_pvc,
            "pvcR16Total": self.pvc_r16_total,
            "pvcR16MatchesHeader": self.pvc_r16_matches_header,
            "knownDevlinesCount": self.known_devlines_count,
            "pvcR3Total": self.pvc_r3_total,
            "pvcR3ResolvedDevlines": self.pvc_r3_resolved_devlines,
            "pvcR3UnresolvedUnique": self.pvc_r3_unresolved_unique,
            "pvcR3UnresolvedIds": self.pvc_r3_unresolved_ids,
            "errors": self.errors,
        }


def parse_pvc_element_tlvs(raw_bytes: bytes) -> Optional[Dict[str, Any]]:
    """
    Parse pvcElement binary TLV layout:
      [4B BE version]
      + 16 length-prefixed prologue fields F1..F16:
          F1..F5  (versioned object header): objectID(16), modelID(4), modelVersion(S), objectType(4), propConfinement(4)
          F6..F16 (version metadata):        versionID(16), objectID(16), branchID_candidate(16), branchSeqNo(4),
                                             objState(4), isDeleted(4), creatorName(S), creationTime(8),
                                             lastModified(8), isArchived(4), versionType(4)
      + [4B BE rowCount]
      + rowCount * 18 length-prefixed relation fields R1..R18:
          R1..R14  (relation record):  relationID, creatorVSID, ownerVSID, objectID,
                                       predVID(0|16), predBRID(0|16), predSeqNo(4),
                                       succVID(16), succBRID(16), succSeqNo(4),
                                       objType(4), objState(4), creatorName(S), creationTime(8)
          R15..R18 (optional 4-field tail):
                                       R15=same-row R1, R16=pvcVersionSet first TLV,
                                       R17=4B BE uint32, R18=same-row R13 creatorName
    """
    if len(raw_bytes) < 12:
        return None
    version = struct.unpack(">I", raw_bytes[:4])[0]
    if version not in (1, 2):
        return None

    pos = 4
    n = len(raw_bytes)

    def read_field() -> Optional[bytes]:
        nonlocal pos
        if pos + 4 > n:
            return None
        flen = struct.unpack(">I", raw_bytes[pos : pos + 4])[0]
        pos += 4
        if flen > n - pos:
            return None
        val = raw_bytes[pos : pos + flen]
        pos += flen
        return val

    def u32(b: bytes) -> int:
        return struct.unpack(">I", b)[0] if len(b) == 4 else 0

    def i64(b: bytes) -> int:
        return struct.unpack(">q", b)[0] if len(b) == 8 else 0

    def txt(b: bytes) -> str:
        return b.decode("utf-8", "replace").strip("\x00 ") if b else ""

    prologue: List[bytes] = []
    for _ in range(16):
        f = read_field()
        if f is None:
            break
        prologue.append(f)

    if len(prologue) < 7:
        return None

    f1 = prologue[0].hex() if len(prologue[0]) == 16 else ""
    f6 = prologue[5].hex() if len(prologue[5]) == 16 else ""
    f7 = prologue[6].hex() if len(prologue[6]) == 16 else ""
    f8 = prologue[7].hex() if len(prologue) >= 8 and len(prologue[7]) == 16 else ""

    row_count = 0
    predecessor_rows = 0
    vis_relation_rows = 0
    r3_count = 0
    owner_vs_ids: List[str] = []
    owner_vs_counts: Dict[str, int] = {}
    tail_vset_ids: List[str] = []
    tail_vset_seen: set[str] = set()
    r17_values: List[int] = []
    r17_seen: set[int] = set()
    exact_consumed = False

    if len(prologue) == 16 and pos + 4 <= n:
        row_count = struct.unpack(">I", raw_bytes[pos : pos + 4])[0]
        pos += 4
        if row_count <= 2048:
            ok_rows = True
            for _ in range(row_count):
                row_fields: List[bytes] = []
                for _r in range(18):
                    rf = read_field()
                    if rf is None:
                        ok_rows = False
                        break
                    row_fields.append(rf)
                if not ok_rows:
                    break
                if len(row_fields[2]) == 16:
                    r3_count += 1
                    r3_hex = row_fields[2].hex()
                    if r3_hex not in owner_vs_counts:
                        owner_vs_ids.append(r3_hex)
                        owner_vs_counts[r3_hex] = 1
                    else:
                        owner_vs_counts[r3_hex] += 1
                if len(row_fields[4]) == 16:
                    predecessor_rows += 1
                if len(row_fields[14]) == 16 and len(row_fields[15]) == 16:
                    vis_relation_rows += 1
                    r16_hex = row_fields[15].hex()
                    if r16_hex not in tail_vset_seen:
                        tail_vset_seen.add(r16_hex)
                        tail_vset_ids.append(r16_hex)
                    if len(row_fields[16]) == 4:
                        r17_val = u32(row_fields[16])
                        if r17_val not in r17_seen:
                            r17_seen.add(r17_val)
                            r17_values.append(r17_val)
            if ok_rows and pos == n:
                exact_consumed = True

    return {
        "version": version,
        "oid": f1,
        "vid": f6,
        "oidRepeat": f7,
        "oidConsistent": bool(f1 and f1 == f7),
        "branchIdCandidate": f8,
        "modelVersion": txt(prologue[2]) if len(prologue) > 2 else "",
        "branchSeqNo": u32(prologue[8]) if len(prologue) > 8 else 0,
        "objState": u32(prologue[9]) if len(prologue) > 9 else 0,
        "isDeleted": bool(u32(prologue[10])) if len(prologue) > 10 else False,
        "creatorName": txt(prologue[11]) if len(prologue) > 11 else "",
        "creationTimeMs": i64(prologue[12]) if len(prologue) > 12 else 0,
        "lastModifiedMs": i64(prologue[13]) if len(prologue) > 13 else 0,
        "isArchived": bool(u32(prologue[14])) if len(prologue) > 14 else False,
        "relationRows": row_count,
        "predecessorRows": predecessor_rows,
        "visRelationRows": vis_relation_rows,
        "r3Count": r3_count,
        "ownerVsIds": owner_vs_ids,
        "ownerVsIdCounts": owner_vs_counts,
        "tailVersionSetIds": tail_vset_ids,
        "r17Values": r17_values,
        "exactConsumed": exact_consumed,
    }


def parse_pvc_version_set_tlvs(raw_bytes: bytes) -> Optional[Dict[str, Any]]:
    """
    Parse pvcVersionSet binary TLV layout:
      [4B BE preamble]
      + 16 length-prefixed prologue TLVs:
          TLV1 (16B): VersionSet ID (matches header/versionSet@id in network byte order)
          TLV2 (16B): secondary UUID (baseVersionSetID candidate)
      + [4B BE rowCount]
      + rowCount * 9 length-prefixed membership TLVs (16, 16, 16, 4, 4, 8, 8, 4, 4 = 116B/row):
          V1 (16B): versionID (VID)
          V2 (16B): objectID (OID)
          V3 (16B): versionSetID (matches header/versionSet@id & TLV1)
          V4 (4B):  u32 raw flag
          V5 (4B):  u32 raw flag
          V6 (8B):  i64 epoch-ms timestamp
          V7 (8B):  i64 epoch-ms timestamp
          V8 (4B):  u32
          V9 (4B):  u32
    """
    n = len(raw_bytes)
    if n < 12:
        return None
    preamble = struct.unpack(">I", raw_bytes[:4])[0]
    pos = 4

    def read_field() -> Optional[bytes]:
        nonlocal pos
        if pos + 4 > n:
            return None
        flen = struct.unpack(">I", raw_bytes[pos : pos + 4])[0]
        pos += 4
        if flen > n - pos:
            return None
        val = raw_bytes[pos : pos + flen]
        pos += flen
        return val

    prologue: List[bytes] = []
    for _ in range(16):
        f = read_field()
        if f is None:
            return None
        prologue.append(f)

    if pos + 4 > n:
        return None
    row_count = struct.unpack(">I", raw_bytes[pos : pos + 4])[0]
    pos += 4
    if row_count > 500000:
        return None

    first_tlv = prologue[0].hex() if len(prologue[0]) == 16 else ""
    second_tlv = prologue[1].hex() if len(prologue[1]) == 16 else ""
    rows: List[Dict[str, Any]] = []
    seen_vids: set[str] = set()
    dup_vids = 0
    rows_matching_first = 0
    v6_eq_v7 = 0

    for _ in range(row_count):
        rfs: List[bytes] = []
        for _k in range(9):
            rf = read_field()
            if rf is None:
                return None
            rfs.append(rf)
        if not (len(rfs[0]) == 16 and len(rfs[1]) == 16 and len(rfs[2]) == 16):
            return None
        vid = rfs[0].hex()
        oid = rfs[1].hex()
        vsid = rfs[2].hex()
        if vid in seen_vids:
            dup_vids += 1
        else:
            seen_vids.add(vid)
        if first_tlv and vsid == first_tlv:
            rows_matching_first += 1
        v4 = struct.unpack(">I", rfs[3])[0] if len(rfs[3]) == 4 else 0
        v5 = struct.unpack(">I", rfs[4])[0] if len(rfs[4]) == 4 else 0
        v6 = struct.unpack(">q", rfs[5])[0] if len(rfs[5]) == 8 else 0
        v7 = struct.unpack(">q", rfs[6])[0] if len(rfs[6]) == 8 else 0
        v8 = struct.unpack(">I", rfs[7])[0] if len(rfs[7]) == 4 else 0
        v9 = struct.unpack(">I", rfs[8])[0] if len(rfs[8]) == 4 else 0
        eq67 = (rfs[5] == rfs[6])
        if eq67:
            v6_eq_v7 += 1
        rows.append({
            "vid": vid,
            "oid": oid,
            "versionSetId": vsid,
            "v4": v4,
            "v5": v5,
            "timestampMs": v6,
            "v6v7Equal": eq67,
            "v8": v8,
            "v9": v9,
        })

    return {
        "preamble": preamble,
        "versionSetId": first_tlv,
        "versionSetIdDashed": format_uuid_dashed(first_tlv),
        "secondTlvHex": second_tlv,
        "rowCount": row_count,
        "duplicateVids": dup_vids,
        "rowsMatchingFirstTlv": rows_matching_first,
        "v6EqualsV7Count": v6_eq_v7,
        "exactConsumed": pos == n,
        "rows": rows,
    }


def parse_known_devlines_tlvs(raw_bytes: bytes) -> Optional[Dict[str, Any]]:
    """
    Parse knownDevlines dictionary segment:
      [4B BE rowCount]
      + rowCount * 5 length-prefixed TLVs:
          F1 (16B): devline UUID (matches pvcElement relation R3 / ownerVSID)
          F2 (8B):  fixed 8-byte field
          F3 (16B): secondary 16-byte UUID
          F4 (var): variable-length field
          F5 (var): variable-length field
    """
    n = len(raw_bytes)
    if n < 4:
        return None
    row_count = struct.unpack(">I", raw_bytes[:4])[0]
    if row_count > 100000:
        return None
    pos = 4

    def read_field() -> Optional[bytes]:
        nonlocal pos
        if pos + 4 > n:
            return None
        flen = struct.unpack(">I", raw_bytes[pos : pos + 4])[0]
        pos += 4
        if flen > n - pos:
            return None
        val = raw_bytes[pos : pos + flen]
        pos += flen
        return val

    def decode_var(b: bytes) -> str:
        if not b:
            return ""
        try:
            s = b.decode("utf-8").strip("\x00 ")
            if s and all(ch.isprintable() or ch in "\t\n\r" for ch in s):
                return s
        except UnicodeDecodeError:
            pass
        return b.hex()[:64]

    entries: List[Dict[str, Any]] = []
    by_id: Dict[str, Dict[str, Any]] = {}
    for _ in range(row_count):
        fs: List[bytes] = []
        for _k in range(5):
            f = read_field()
            if f is None:
                return None
            fs.append(f)
        if not (len(fs[0]) == 16 and len(fs[1]) == 8 and len(fs[2]) == 16):
            return None
        id_hex = fs[0].hex()
        entry = {
            "idHex": id_hex,
            "id": format_uuid_dashed(id_hex),
            "field2Hex": fs[1].hex(),
            "field3": format_uuid_dashed(fs[2].hex()),
            "field4": decode_var(fs[3]),
            "field5": decode_var(fs[4]),
        }
        entries.append(entry)
        by_id[id_hex] = entry

    return {
        "rowCount": row_count,
        "exactConsumed": pos == n,
        "entries": entries,
        "byId": by_id,
    }


def parse_pvc_vset_specialization_tlvs(raw_bytes: bytes) -> Optional[Dict[str, Any]]:
    """
    Parse pvcVersionSetSpecialization binary layout (32 bytes):
      [4B BE preamble (=1)]
      + TLV1 (16B): VersionSet UUID (matches header/versionSet@id in network byte order)
      + TLV2 (4B BE u32): specialization code
    """
    n = len(raw_bytes)
    if n < 12:
        return None
    preamble = struct.unpack(">I", raw_bytes[:4])[0]
    pos = 4

    def read_field() -> Optional[bytes]:
        nonlocal pos
        if pos + 4 > n:
            return None
        flen = struct.unpack(">I", raw_bytes[pos : pos + 4])[0]
        pos += 4
        if flen > n - pos:
            return None
        val = raw_bytes[pos : pos + flen]
        pos += flen
        return val

    f1 = read_field()
    f2 = read_field()
    if f1 is None or f2 is None or len(f1) != 16 or len(f2) != 4:
        return None
    vset_hex = f1.hex()
    spec_code = struct.unpack(">I", f2)[0]
    return {
        "preamble": preamble,
        "versionSetId": vset_hex,
        "versionSetIdDashed": format_uuid_dashed(vset_hex),
        "specCode": spec_code,
        "exactConsumed": pos == n,
    }


@dataclass
class UnchunkedTpt:
    logical: bytes
    catalog_xml: bytes
    cat_mode: str
    segments: List[LogicalSegment]
    report: TptVerificationReport


def is_standard_tpt(raw: bytes) -> bool:
    return len(raw) >= 64 and raw[:8] == TPT_MAGIC


def _parse_catalog_segments(cat_xml: bytes, logical: bytes) -> List[LogicalSegment]:
    obj_start = cat_xml.find(b"<objectList")
    obj_end = cat_xml.find(b"</objectList>")
    segs: List[LogicalSegment] = []
    for m in SEG_TAG_RE.finditer(cat_xml):
        attrs = {
            am.group(1).decode("ascii", "replace").lower(): am.group(2)
            for am in SEG_ATTR_RE.finditer(m.group(1))
        }
        try:
            off = int(attrs.get("offset", b"-1"))
            ln = int(attrs.get("length", b"-1"))
        except ValueError:
            continue
        if off < 0 or ln <= 0 or off + ln > len(logical):
            continue
        pos = m.start()
        in_obj = obj_start >= 0 and obj_start < pos and (obj_end < 0 or pos < obj_end)
        segs.append(
            LogicalSegment(
                type=attrs.get("type", b"?").decode("utf-8", "replace"),
                offset=off,
                length=ln,
                in_object_list=in_obj,
                raw_bytes=logical[off : off + ln],
            )
        )
    return segs


def unchunk_tpt(raw: bytes) -> UnchunkedTpt:
    """Strip 1-MiB CRC32 checkpoints from physical .tpt/.dlt and verify all integrity checks."""
    errors: List[str] = []
    if not is_standard_tpt(raw):
        raise ValueError("Container does not begin with SAP TPT magic (00000000dc358a91).")

    eof_logical = struct.unpack(">Q", raw[-8:])[0]
    if eof_logical < HEADER_PREAMBLE_LEN or eof_logical >= len(raw):
        raise ValueError(f"Invalid eof_logical pointer in EOF trailer: {eof_logical} (file size={len(raw)})")

    logical = bytearray()
    pos = 0
    blk_idx = 0
    chunks_checked = 0
    chunks_ok = 0
    last_calc_crc = 0

    while len(logical) < eof_logical:
        need = min(CHUNK_SIZE, eof_logical - len(logical))
        if pos + need > len(raw) - 8:
            raise ValueError(f"Truncated TPT stream at physical offset {pos} (need {need} bytes)")
        blk = raw[pos : pos + need]
        logical.extend(blk)
        seed = 0 if blk_idx == 0 else CHUNK_SEED
        last_calc_crc = zlib.crc32(blk, seed) & 0xFFFFFFFF
        pos += need
        if need == CHUNK_SIZE and len(logical) < eof_logical:
            if pos + 8 > len(raw) - 8:
                raise ValueError(f"Truncated 1-MiB checkpoint at physical offset {pos}")
            z4, stored = struct.unpack(">II", raw[pos : pos + 8])
            chunks_checked += 1
            if z4 == 0 and stored == last_calc_crc:
                chunks_ok += 1
            else:
                errors.append(
                    f"1-MiB chunk[{blk_idx}] CRC mismatch: z4={z4:08x} stored={stored:08x} calc={last_calc_crc:08x}"
                )
            pos += 8
            blk_idx += 1

    if pos + 8 > len(raw) - 8:
        raise ValueError(f"Missing pre-catalog 8B checksum at physical offset {pos}")

    pre_z4, pre_stored = struct.unpack(">II", raw[pos : pos + 8])
    raw_cat = memoryview(raw)[pos + 8 : len(raw) - 8]

    # Multi-block catalog framing:
    # When (eof_logical % 1 MiB) + len(catalog) > 1 MiB, the 1-MiB CRC stream continues
    # into the catalog XML! First catalog marker sits after first_gap = 1 MiB - tail bytes,
    # chained from last_calc_crc; subsequent full 1-MiB catalog blocks use seed CHUNK_SEED.
    tail = eof_logical % CHUNK_SIZE
    first_gap = (CHUNK_SIZE - tail) if tail > 0 else CHUNK_SIZE
    cat_markers_checked = 0
    cat_markers_ok = 0

    if len(raw_cat) <= first_gap:
        cat_xml = bytes(raw_cat)
    else:
        cat_parts: List[memoryview] = []
        if first_gap + 8 > len(raw_cat):
            errors.append(f"Truncated catalog marker 1 at catalog offset {first_gap}")
            cat_xml = bytes(raw_cat)
        else:
            seg0 = raw_cat[:first_gap]
            mz4, mstored = struct.unpack(">II", raw_cat[first_gap : first_gap + 8])
            expect0 = zlib.crc32(seg0, last_calc_crc) & 0xFFFFFFFF
            cat_markers_checked += 1
            if mz4 == 0 and mstored == expect0:
                cat_markers_ok += 1
            else:
                errors.append(
                    f"Catalog marker[0] CRC mismatch: z4={mz4:08x} stored={mstored:08x} calc={expect0:08x}"
                )
            cat_parts.append(seg0)
            cpos = first_gap + 8
            while len(raw_cat) - cpos > CHUNK_SIZE:
                if cpos + CHUNK_SIZE + 8 > len(raw_cat):
                    errors.append(f"Truncated catalog marker {cat_markers_checked + 1}")
                    break
                seg = raw_cat[cpos : cpos + CHUNK_SIZE]
                mz4, mstored = struct.unpack(">II", raw_cat[cpos + CHUNK_SIZE : cpos + CHUNK_SIZE + 8])
                expect = zlib.crc32(seg, CHUNK_SEED) & 0xFFFFFFFF
                cat_markers_checked += 1
                if mz4 == 0 and mstored == expect:
                    cat_markers_ok += 1
                else:
                    errors.append(
                        f"Catalog marker[{cat_markers_checked - 1}] CRC mismatch: z4={mz4:08x} stored={mstored:08x} calc={expect:08x}"
                    )
                cat_parts.append(seg)
                cpos += CHUNK_SIZE + 8
            cat_parts.append(raw_cat[cpos:])
            cat_xml = b"".join(cat_parts)

    cat_starts_xml = cat_xml.startswith(b"<?xml")
    if not cat_starts_xml:
        errors.append("Catalog block after pre-catalog checksum does not start with <?xml")

    cat_crc = zlib.crc32(cat_xml) & 0xFFFFFFFF
    if pre_z4 == 0 and pre_stored == last_calc_crc:
        cat_mode = "stream_crc"
        pre_cat_ok = True
    elif pre_z4 == 0 and pre_stored == cat_crc:
        cat_mode = "cat_crc"
        pre_cat_ok = True
    else:
        cat_mode = "mismatch"
        pre_cat_ok = False
        errors.append(
            f"Pre-catalog CRC mismatch: z4={pre_z4:08x} stored={pre_stored:08x} "
            f"stream_crc={last_calc_crc:08x} cat_crc={cat_crc:08x}"
        )

    logical_bytes = bytes(logical)
    segments = _parse_catalog_segments(cat_xml, logical_bytes)

    # Verify header CRC and extract network-byte-order header/versionSet@id
    header_crc_ok = False
    header_vset_hex = ""
    hdr_seg = next((s for s in segments if s.type == "header"), None)
    if hdr_seg is not None and len(hdr_seg.raw_bytes) >= 16:
        h_len, h_zero, h_crc = struct.unpack(">QII", hdr_seg.raw_bytes[:16])
        hdr_xml = hdr_seg.raw_bytes[16:]
        calc_hdr = zlib.crc32(hdr_xml) & 0xFFFFFFFF
        header_crc_ok = (h_zero == 0 and h_len + 8 == hdr_seg.length and h_crc == calc_hdr)
        header_vset_hex = extract_header_versionset_id(hdr_xml)
        if not header_crc_ok:
            errors.append(f"Header CRC mismatch: stored={h_crc:08x} calc={calc_hdr:08x}")
    else:
        errors.append("Missing or truncated header segment in catalog")

    # Verify segment contiguity and modelElement [8B len] framing
    contiguous = bool(segments) and segments[0].offset == HEADER_PREAMBLE_LEN
    if contiguous:
        for i in range(len(segments) - 1):
            if segments[i].offset + segments[i].length != segments[i + 1].offset:
                contiguous = False
                break
        if segments[-1].offset + segments[-1].length != len(logical_bytes):
            contiguous = False

    me_total = 0
    me_exact = 0
    pvc_total = 0
    pvc_ok = 0
    pvc_vid_oid_pairs: set[Tuple[str, str]] = set()
    pvc_r16_total = 0
    pvc_r16_matches_header = 0
    pvc_r3_row_counts: Dict[str, int] = {}
    vset_parsed: Optional[Dict[str, Any]] = None
    vset_spec_parsed: Optional[Dict[str, Any]] = None
    devlines_parsed: Optional[Dict[str, Any]] = None

    for s in segments:
        if s.type == "modelElement":
            me_total += 1
            if len(s.raw_bytes) >= 8 and struct.unpack(">Q", s.raw_bytes[:8])[0] + 8 == s.length:
                me_exact += 1
        elif s.type == "pvcElement":
            pvc_total += 1
            parsed_pvc = parse_pvc_element_tlvs(s.raw_bytes)
            if parsed_pvc:
                if parsed_pvc["oidConsistent"]:
                    pvc_ok += 1
                if parsed_pvc.get("vid") and parsed_pvc.get("oid"):
                    pvc_vid_oid_pairs.add((parsed_pvc["vid"], parsed_pvc["oid"]))
                for r16 in parsed_pvc.get("tailVersionSetIds") or []:
                    pvc_r16_total += 1
                    if header_vset_hex and r16 == header_vset_hex:
                        pvc_r16_matches_header += 1
                for r3_hex, cnt in (parsed_pvc.get("ownerVsIdCounts") or {}).items():
                    pvc_r3_row_counts[r3_hex] = pvc_r3_row_counts.get(r3_hex, 0) + cnt
        elif s.type == "pvcVersionSet" and vset_parsed is None:
            vset_parsed = parse_pvc_version_set_tlvs(s.raw_bytes)
        elif s.type == "pvcVersionSetSpecialization" and vset_spec_parsed is None:
            vset_spec_parsed = parse_pvc_vset_specialization_tlvs(s.raw_bytes)
        elif s.type == "knownDevlines" and devlines_parsed is None:
            devlines_parsed = parse_known_devlines_tlvs(s.raw_bytes)

    vset_first_matches_hdr: Optional[bool] = None
    vset_spec_code: Optional[int] = None
    vset_spec_matches_hdr: Optional[bool] = None
    if vset_spec_parsed and vset_spec_parsed.get("exactConsumed"):
        vset_spec_code = int(vset_spec_parsed["specCode"])
        if header_vset_hex and vset_spec_parsed.get("versionSetId"):
            vset_spec_matches_hdr = (vset_spec_parsed["versionSetId"] == header_vset_hex)
    vset_rows_total = 0
    vset_rows_match_hdr = 0
    vset_rows_joined_pvc = 0
    if vset_parsed and vset_parsed.get("exactConsumed"):
        vset_rows_total = int(vset_parsed.get("rowCount", 0))
        if header_vset_hex and vset_parsed.get("versionSetId"):
            vset_first_matches_hdr = (vset_parsed["versionSetId"] == header_vset_hex)
        for row in vset_parsed.get("rows") or []:
            if header_vset_hex and row["versionSetId"] == header_vset_hex:
                vset_rows_match_hdr += 1
            if (row["vid"], row["oid"]) in pvc_vid_oid_pairs:
                vset_rows_joined_pvc += 1

    known_devlines_count = 0
    pvc_r3_total = sum(pvc_r3_row_counts.values())
    pvc_r3_resolved = 0
    pvc_r3_unresolved_hex: List[str] = []
    dl_by_id: Dict[str, Dict[str, Any]] = {}
    if devlines_parsed and devlines_parsed.get("exactConsumed"):
        known_devlines_count = int(devlines_parsed.get("rowCount", 0))
        dl_by_id = devlines_parsed.get("byId") or {}
        for r3_hex, cnt in pvc_r3_row_counts.items():
            if r3_hex in dl_by_id:
                pvc_r3_resolved += cnt
            else:
                pvc_r3_unresolved_hex.append(r3_hex)
    elif pvc_r3_row_counts:
        pvc_r3_unresolved_hex = list(pvc_r3_row_counts.keys())
    pvc_r3_unresolved_hex.sort(key=lambda h: -pvc_r3_row_counts.get(h, 0))
    pvc_r3_unresolved_ids = [format_uuid_dashed(h) for h in pvc_r3_unresolved_hex[:32]]

    vset_second_tlv_id = ""
    vset_second_tlv_in_dl: Optional[bool] = None
    vset_second_tlv_dl_label = ""
    if vset_parsed and vset_parsed.get("exactConsumed") and vset_parsed.get("secondTlvHex"):
        tlv2_hex = vset_parsed["secondTlvHex"]
        vset_second_tlv_id = format_uuid_dashed(tlv2_hex)
        if dl_by_id:
            hit2 = dl_by_id.get(tlv2_hex)
            vset_second_tlv_in_dl = hit2 is not None
            if hit2:
                vset_second_tlv_dl_label = hit2.get("field4") or hit2.get("field5") or ""

    verified = (
        len(errors) == 0
        and chunks_ok == chunks_checked
        and cat_markers_ok == cat_markers_checked
        and header_crc_ok
        and pre_cat_ok
        and cat_starts_xml
    )

    report = TptVerificationReport(
        valid_magic=True,
        verified=verified,
        physical_bytes=len(raw),
        logical_bytes=len(logical_bytes),
        chunks_checked=chunks_checked,
        chunks_ok=chunks_ok,
        header_crc_ok=header_crc_ok,
        pre_catalog_crc_ok=pre_cat_ok,
        cat_mode=cat_mode,
        catalog_starts_xml=cat_starts_xml,
        segment_count=len(segments),
        contiguous_segments=contiguous,
        model_elements_exact=me_exact,
        model_elements_total=me_total,
        pvc_elements_total=pvc_total,
        pvc_oid_consistent=pvc_ok,
        cat_markers_checked=cat_markers_checked,
        cat_markers_ok=cat_markers_ok,
        header_version_set_id=format_uuid_dashed(header_vset_hex) if header_vset_hex else "",
        vset_first_tlv_matches_header=vset_first_matches_hdr,
        vset_second_tlv_id=vset_second_tlv_id,
        vset_second_tlv_in_devlines=vset_second_tlv_in_dl,
        vset_second_tlv_devline_label=vset_second_tlv_dl_label,
        vset_spec_code=vset_spec_code,
        vset_spec_matches_header=vset_spec_matches_hdr,
        vset_membership_rows=vset_rows_total,
        vset_membership_matches_header=vset_rows_match_hdr,
        vset_membership_joined_pvc=vset_rows_joined_pvc,
        pvc_r16_total=pvc_r16_total,
        pvc_r16_matches_header=pvc_r16_matches_header,
        known_devlines_count=known_devlines_count,
        pvc_r3_total=pvc_r3_total,
        pvc_r3_resolved_devlines=pvc_r3_resolved,
        pvc_r3_unresolved_unique=len(pvc_r3_unresolved_hex),
        pvc_r3_unresolved_ids=pvc_r3_unresolved_ids,
        errors=errors,
    )

    return UnchunkedTpt(
        logical=logical_bytes,
        catalog_xml=cat_xml,
        cat_mode=cat_mode,
        segments=segments,
        report=report,
    )


def rechunk_tpt(logical: bytes, cat_xml: bytes, cat_mode: str = "stream_crc") -> bytes:
    """Wrap a logical .tpt/.dlt stream into physical 1-MiB CRC32-framed format."""
    out = bytearray()
    eof_logical = len(logical)
    off = 0
    blk_idx = 0
    last_crc = 0

    while off < eof_logical:
        blk = logical[off : off + CHUNK_SIZE]
        out.extend(blk)
        seed = 0 if blk_idx == 0 else CHUNK_SEED
        last_crc = zlib.crc32(blk, seed) & 0xFFFFFFFF
        off += len(blk)
        if len(blk) == CHUNK_SIZE and off < eof_logical:
            out.extend(struct.pack(">II", 0, last_crc))
            blk_idx += 1

    pre_cat_crc = (zlib.crc32(cat_xml) & 0xFFFFFFFF) if cat_mode == "cat_crc" else last_crc
    out.extend(struct.pack(">II", 0, pre_cat_crc))

    # Continue 1-MiB block framing across large multi-block catalogs
    tail = eof_logical % CHUNK_SIZE
    first_gap = (CHUNK_SIZE - tail) if tail > 0 else CHUNK_SIZE
    cat_view = memoryview(cat_xml)
    if len(cat_view) <= first_gap:
        out.extend(cat_view)
    else:
        seg0 = cat_view[:first_gap]
        out.extend(seg0)
        out.extend(struct.pack(">II", 0, zlib.crc32(seg0, last_crc) & 0xFFFFFFFF))
        coff = first_gap
        while len(cat_view) - coff > CHUNK_SIZE:
            seg = cat_view[coff : coff + CHUNK_SIZE]
            out.extend(seg)
            out.extend(struct.pack(">II", 0, zlib.crc32(seg, CHUNK_SEED) & 0xFFFFFFFF))
            coff += CHUNK_SIZE
        out.extend(cat_view[coff:])

    out.extend(struct.pack(">Q", eof_logical))
    return bytes(out)


def _rewrite_catalog_offsets(cat_xml: bytes, new_spans: List[Tuple[int, int]]) -> bytes:
    """Replace offset and length attributes on every <segment ...> in document order."""
    idx = [0]

    def _sub_seg(m: re.Match) -> bytes:
        if idx[0] >= len(new_spans):
            return m.group(0)
        new_off, new_len = new_spans[idx[0]]
        idx[0] += 1
        tag_bytes = m.group(0)
        tag_bytes = OFFSET_ATTR_RE.sub(lambda om: om.group(1) + str(new_off).encode("ascii") + om.group(3), tag_bytes, count=1)
        tag_bytes = LENGTH_ATTR_RE.sub(lambda lm: lm.group(1) + str(new_len).encode("ascii") + lm.group(3), tag_bytes, count=1)
        return tag_bytes

    return SEG_TAG_RE.sub(_sub_seg, cat_xml)


def sanitize_xml_text(xml_text: str) -> Tuple[str, int]:
    """Sanitize sensitive endpoints, IPs, emails, and channel credentials while keeping valid XML."""
    changes = 0

    # 1) Mask sensitive Channel <Attribute ...><Name>...</Name>...<Value>...</Value></Attribute> values
    attr_re = re.compile(
        r"(<Attribute\b[^>]*>\s*<Name>([^<]+)</Name>(?:\s*<Namespace\s*/>|\s*<Namespace>[^<]*</Namespace>)?\s*<Value>)([^<]*)(</Value>)",
        re.S,
    )

    def _mask_attr(m: re.Match) -> str:
        nonlocal changes
        aname = m.group(2).strip().lower()
        aval = m.group(3)
        if not aval.strip():
            return m.group(0)
        if any(h in aname for h in SENSITIVE_ATTR_HINTS):
            changes += 1
            return m.group(1) + "REDACTED_" + m.group(2).strip().upper().replace(".", "_") + m.group(4)
        return m.group(0)

    xml_text = attr_re.sub(_mask_attr, xml_text)

    # 2) Sanitize transport URLs inside <Value>...</Value> (never touch xmlns="..." or SAP namespace URIs!)
    val_re = re.compile(r"(<Value>)([^<]+)(</Value>)")

    def _mask_val_urls(m: re.Match) -> str:
        nonlocal changes
        v = m.group(2)
        if "sap.com/xi" in v.lower() or "w3.org" in v.lower() or "xmlsoap.org" in v.lower():
            return m.group(0)
        v2 = URL_RE.sub(lambda um: f"{um.group(1)}://sanitized.example.local/endpoint", v)
        v2 = IPV4_RE.sub("10.0.0.1", v2)
        v2 = EMAIL_RE.sub("sanitized@example.local", v2)
        if v2 != v:
            changes += 1
            return m.group(1) + v2 + m.group(3)
        return m.group(0)

    xml_text = val_re.sub(_mask_val_urls, xml_text)

    # 3) Mask <p1:modifBy>, <p1:owner> usernames
    def _mask_user(m: re.Match) -> str:
        nonlocal changes
        if m.group(2).strip() and m.group(2).strip() != "SAP_USER":
            changes += 1
            return m.group(1) + "SAP_USER" + m.group(3)
        return m.group(0)

    xml_text = re.sub(r"(<p1:(?:modifBy|owner)>)([^<]+)(</p1:(?:modifBy|owner)>)", _mask_user, xml_text)
    return xml_text, changes


def apply_channel_patches(xml_text: str, channel_patches: List[Dict[str, str]]) -> Tuple[str, int]:
    """Patch specific Channel <Attribute><Name>...</Name>...<Value>...</Value></Attribute> entries."""
    if not channel_patches or "Channel>" not in xml_text:
        return xml_text, 0

    changes = 0
    for patch in channel_patches:
        target_ch = (patch.get("channelName") or "").strip()
        target_attr = (patch.get("attribute") or "").strip()
        new_val = patch.get("value", "")
        if not target_attr:
            continue
        if target_ch and not re.search(rf"<(?:[\w.-]+:)?elem>{re.escape(target_ch)}</(?:[\w.-]+:)?elem>", xml_text):
            continue

        escaped_val = (
            str(new_val)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        pat = re.compile(
            rf"(<Attribute\b[^>]*>\s*<Name>{re.escape(target_attr)}</Name>(?:\s*<Namespace\s*/>|\s*<Namespace>[^<]*</Namespace>)?\s*)"
            rf"(?:<Value\s*/>|<Value>[^<]*</Value>)",
            re.S,
        )

        def _repl(m: re.Match) -> str:
            nonlocal changes
            changes += 1
            return f"{m.group(1)}<Value>{escaped_val}</Value>"

        xml_text = pat.sub(_repl, xml_text)

    return xml_text, changes


def repack_tpt(
    raw_tpt: bytes,
    transform_model_xml: Optional[Callable[[str], Tuple[str, int]]] = None,
    transform_header_xml: Optional[Callable[[str], Tuple[str, int]]] = None,
) -> Tuple[bytes, Dict[str, Any]]:
    """
    Repack a .tpt/.dlt container after applying transforms to modelElement/header XML payloads.
    Recomputes [8B BE len], header CRC32, <catalog> segment offsets/lengths, 1-MiB CRC32 checkpoints,
    pre-catalog CRC32, and EOF logical catalog pointer, then self-verifies the result.
    """
    parsed = unchunk_tpt(raw_tpt)
    if not parsed.report.contiguous_segments:
        raise ValueError("Cannot safely repack non-contiguous TPT segment layout.")

    new_logical = bytearray(parsed.logical[:HEADER_PREAMBLE_LEN])
    new_spans: List[Tuple[int, int]] = []
    segments_modified = 0
    total_edits = 0

    for seg in parsed.segments:
        new_off = len(new_logical)
        seg_bytes = seg.raw_bytes

        if seg.type == "header" and transform_header_xml is not None and len(seg_bytes) >= 16:
            hdr_xml_str = seg_bytes[16:].decode("utf-8", "replace")
            updated_str, n_edits = transform_header_xml(hdr_xml_str)
            if n_edits > 0 and updated_str != hdr_xml_str:
                new_xml_bytes = updated_str.encode("utf-8")
                new_crc = zlib.crc32(new_xml_bytes) & 0xFFFFFFFF
                seg_bytes = struct.pack(">QII", len(new_xml_bytes) + 8, 0, new_crc) + new_xml_bytes
                segments_modified += 1
                total_edits += n_edits

        elif seg.type == "modelElement" and transform_model_xml is not None and len(seg_bytes) >= 8:
            orig_l8 = struct.unpack(">Q", seg_bytes[:8])[0]
            if orig_l8 + 8 == len(seg_bytes):
                xml_str = seg_bytes[8:].decode("utf-8", "replace")
                updated_str, n_edits = transform_model_xml(xml_str)
                if n_edits > 0 and updated_str != xml_str:
                    new_xml_bytes = updated_str.encode("utf-8")
                    seg_bytes = struct.pack(">Q", len(new_xml_bytes)) + new_xml_bytes
                    segments_modified += 1
                    total_edits += n_edits

        new_logical.extend(seg_bytes)
        new_spans.append((new_off, len(seg_bytes)))

    new_cat_xml = _rewrite_catalog_offsets(parsed.catalog_xml, new_spans)
    cat_mode = parsed.cat_mode if parsed.cat_mode in ("stream_crc", "cat_crc") else "stream_crc"
    rebuilt = rechunk_tpt(bytes(new_logical), new_cat_xml, cat_mode=cat_mode)

    # Mandatory self-verification before returning!
    check = unchunk_tpt(rebuilt)
    if not check.report.verified:
        raise RuntimeError(f"Repacked TPT failed self-verification: {check.report.errors}")

    return rebuilt, {
        "segmentsModified": segments_modified,
        "totalEdits": total_edits,
        "origBytes": len(raw_tpt),
        "newBytes": len(rebuilt),
        "verification": check.report.to_dict(),
    }


def verify_tpz_bytes(raw_tpz: bytes) -> Dict[str, Any]:
    """Verify binary CRC32 & segment integrity of all .tpt/.dlt containers inside a .tpz archive."""
    results: List[Dict[str, Any]] = []
    all_verified = True
    with zipfile.ZipFile(io.BytesIO(raw_tpz), "r") as zf:
        for info in zf.infolist():
            if info.is_dir() or not info.filename.lower().endswith((".tpt", ".dlt")):
                continue
            cdata = zf.read(info)
            try:
                parsed = unchunk_tpt(cdata)
                rep = parsed.report.to_dict()
                rep["zipFlagBit3"] = bool(info.flag_bits & 0x08)
                if not parsed.report.verified:
                    all_verified = False
                results.append({"container": os.path.basename(info.filename), **rep})
            except Exception as exc:
                all_verified = False
                results.append({
                    "container": os.path.basename(info.filename),
                    "validMagic": False,
                    "verified": False,
                    "errors": [str(exc)],
                })
    return {
        "allVerified": all_verified and len(results) > 0,
        "containerCount": len(results),
        "containers": results,
    }


def repack_tpz_bytes(
    raw_tpz: bytes,
    replacements: Optional[List[Dict[str, str]]] = None,
    channel_patches: Optional[List[Dict[str, str]]] = None,
    sanitize: bool = False,
    include_header: bool = False,
) -> Tuple[bytes, Dict[str, Any]]:
    """
    Create a new, CRC32-verified .tpz archive from `raw_tpz` applying optional:
      - `sanitize=True` (anonymize channel secrets, URLs, IPs, emails, usernames, repository host)
      - `channel_patches` (`[{"channelName": "...", "attribute": "...", "value": "..."}]`)
      - `replacements` (`[{"find": "...", "replace": "..."}]`)
    """
    repl_list = [r for r in (replacements or []) if r.get("find")]
    ch_patches = channel_patches or []

    def _transform_model(xml_text: str) -> Tuple[str, int]:
        edits = 0
        txt = xml_text
        if sanitize:
            txt, n = sanitize_xml_text(txt)
            edits += n
        if ch_patches:
            txt, n = apply_channel_patches(txt, ch_patches)
            edits += n
        for r in repl_list:
            needle = r["find"]
            subst = r.get("replace", "")
            cnt = txt.count(needle)
            if cnt > 0:
                txt = txt.replace(needle, subst)
                edits += cnt
        return txt, edits

    def _transform_header(hdr_text: str) -> Tuple[str, int]:
        edits = 0
        txt = hdr_text
        if sanitize:
            txt2, n = re.subn(r'(<repositoryName\s+value=")([^"]+)(")', r'\1SANITIZED_PO_SYS\3', txt)
            txt, edits = txt2, edits + n
        if include_header:
            for r in repl_list:
                needle = r["find"]
                subst = r.get("replace", "")
                cnt = txt.count(needle)
                if cnt > 0:
                    txt = txt.replace(needle, subst)
                    edits += cnt
        return txt, edits

    out_buf = io.BytesIO()
    container_stats: List[Dict[str, Any]] = []
    total_edits = 0

    with zipfile.ZipFile(io.BytesIO(raw_tpz), "r") as src_zf, zipfile.ZipFile(
        out_buf, "w", compression=zipfile.ZIP_DEFLATED
    ) as dst_zf:
        for info in src_zf.infolist():
            if info.is_dir():
                continue
            member_data = src_zf.read(info)
            if info.filename.lower().endswith((".tpt", ".dlt")) and is_standard_tpt(member_data):
                new_tpt, cstat = repack_tpt(
                    member_data,
                    transform_model_xml=_transform_model,
                    transform_header_xml=_transform_header if (sanitize or include_header) else None,
                )
                total_edits += cstat["totalEdits"]
                container_stats.append({"container": os.path.basename(info.filename), **cstat})
                dst_zf.writestr(info.filename, new_tpt)
            else:
                dst_zf.writestr(info.filename, member_data)

    return out_buf.getvalue(), {
        "totalEdits": total_edits,
        "sanitized": sanitize,
        "containers": container_stats,
    }


def _cli() -> None:
    ap = argparse.ArgumentParser(description="SAP PI/PO TPZ Binary Codec (Verify / Repack / Sanitize)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_ver = sub.add_parser("verify", help="Verify CRC32 checkpoints & catalog offsets in a .tpz")
    p_ver.add_argument("tpz_file")

    p_rep = sub.add_parser("repack", help="Repack / sanitize / patch a .tpz into a new CRC-valid .tpz")
    p_rep.add_argument("input_tpz")
    p_rep.add_argument("output_tpz")
    p_rep.add_argument("--sanitize", action="store_true", help="Anonymize secrets, URLs, IPs, usernames")
    p_rep.add_argument("--replace", action="append", default=[], help="Find=Replace pair (repeatable)")

    args = ap.parse_args()
    if args.cmd == "verify":
        with open(args.tpz_file, "rb") as f:
            rep = verify_tpz_bytes(f.read())
        print(json.dumps(rep, indent=2, ensure_ascii=False))
        sys.exit(0 if rep["allVerified"] else 1)

    if args.cmd == "repack":
        repls = []
        for pair in args.replace:
            if "=" in pair:
                k, v = pair.split("=", 1)
                repls.append({"find": k, "replace": v})
        with open(args.input_tpz, "rb") as f:
            raw = f.read()
        out_bytes, summary = repack_tpz_bytes(raw, replacements=repls, sanitize=args.sanitize)
        with open(args.output_tpz, "wb") as f:
            f.write(out_bytes)
        print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    _cli()
