#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import base64
import io
import json
import os
import struct
import sys
import threading
import unittest
import urllib.request
import zipfile
import zlib
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from engine import LocalTpzEngine  # noqa: E402
from standalone_server import ENGINE as GLOBAL_ENGINE, TpzStudioHandler  # noqa: E402
from tpt_codec import (  # noqa: E402
    TPT_MAGIC,
    rechunk_tpt,
    repack_tpt,
    repack_tpz_bytes,
    unchunk_tpt,
    verify_tpz_bytes,
)


def _build_tpt_bytes(model_xmls: list[bytes], cat_mode: str = "stream_crc") -> bytes:
    """Build a spec-compliant SAP .tpt/.dlt binary container with valid header CRC32, 1-MiB framing, and catalog."""
    header_xml = b'<?xml version="1.0" encoding="UTF-8"?><header><sourcesystem>DEV</sourcesystem></header>'
    hdr_seg = struct.pack(">QII", 8 + len(header_xml), 0, zlib.crc32(header_xml) & 0xFFFFFFFF) + header_xml

    logical = bytearray(TPT_MAGIC + b"\x00" * 30)
    hdr_off = len(logical)
    logical.extend(hdr_seg)

    cat_parts = [f'<segment type="header" offset="{hdr_off}" length="{len(hdr_seg)}"/>']
    obj_parts = []
    for xml_bytes in model_xmls:
        rec = struct.pack(">Q", len(xml_bytes)) + xml_bytes
        off = len(logical)
        logical.extend(rec)
        obj_parts.append(f'<segment type="modelElement" offset="{off}" length="{len(rec)}"/>')

    cat_xml = (
        '<?xml version="1.0" encoding="UTF-8"?><catalog version="2.1"><segments>'
        + "".join(cat_parts)
        + "<objectList>"
        + "".join(obj_parts)
        + "</objectList></segments></catalog>\n"
    ).encode("utf-8")
    return rechunk_tpt(bytes(logical), cat_xml, cat_mode=cat_mode)


def _pack_tpz(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _make_channel_xml(oid: str, service: str, name: str, target_url: str, soap_action: str) -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<p1:xiObj xmlns:p1="urn:sap-com:xi" xmlns:ns1="urn:sap-com:xi:xiChannel">
  <p1:idInfo VID="v1"><p1:key typeID="Channel" oid="{oid}">
    <p1:elem/><p1:elem>{service}</p1:elem><p1:elem>{name}</p1:elem>
  </p1:key></p1:idInfo>
  <p1:generic><p1:lnks>
    <p1:lnkRole role="ADAPTER"><p1:lnk><p1:key typeID="AdapterMetaData" oid="adp1">
      <p1:elem>SOAP</p1:elem><p1:elem>http://sap.com/xi/XI/System</p1:elem>
    </p1:key></p1:lnk></p1:lnkRole>
  </p1:lnks></p1:generic>
  <p1:content><ns1:Channel>
    <ns1:ChannelDirection>O</ns1:ChannelDirection>
    <ns1:TransportProtocol>HTTP</ns1:TransportProtocol>
    <ns1:MessageProtocol>SOAP</ns1:MessageProtocol>
    <ns1:ChannelAttributes><AdapterTypeData>
      <Attribute><Name>XMBWS.TargetURL</Name><Value>{target_url}</Value></Attribute>
      <Attribute><Name>XMBWS.DefaultSOAPAction</Name><Value>{soap_action}</Value></Attribute>
      <Attribute><Name>XMBWS.User</Name><Value>svc_prod_user</Value></Attribute>
      <Attribute><Name>XMBWS.Password</Name><Value>SuperSecretProdPass!</Value></Attribute>
    </AdapterTypeData></ns1:ChannelAttributes>
  </ns1:Channel></p1:content>
</p1:xiObj>""".encode("utf-8")


def _make_sample_channels_tpz() -> bytes:
    ch1 = _make_channel_xml(
        "ch001", "BC_PAYMENTS", "CC_SOAP_PAYMENT_LIST_RCV",
        "https://prod.payments.internal:8443/soap/list",
        "https://prod.payments.internal/PosPaymentList",
    )
    ch2 = _make_channel_xml(
        "ch002", "BC_PAYMENTS", "CC_SOAP_PAYMENT_POST_RCV",
        "https://prod.payments.internal:8443/soap/post",
        "https://prod.payments.internal/PosPaymentPost",
    )
    ch3 = _make_channel_xml(
        "ch003", "BC_ERP", "CC_SOAP_STATUS_SND",
        "https://10.42.19.8:50000/XISOAPAdapter/MessageServlet",
        "urn:erp:status",
    )
    tpt = _build_tpt_bytes([ch1, ch2, ch3], cat_mode="stream_crc")
    return _pack_tpz({"Metadata.properties": b"swcv=SAMPLE_DIR 1.0\n", "channels.tpt": tpt})


def _make_multichunk_tpz() -> bytes:
    """Create a >1.2 MiB multi-chunk TPZ containing sensitive URLs/IPs/credentials and a Message Mapping."""
    mt_xml = b"""<mappingtool version="XI7.1"><project>
      <transformation>
        <brick type="Dst" path="/Target/OrderId">
          <arg pin="0"><brick type="Src" path="/Source/OrderId"/></arg>
        </brick>
        <brick type="Dst" path="/Target/Status">
          <arg pin="0"><brick type="Func" fname="const"><param name="value" value="OK"/></brick></arg>
        </brick>
      </transformation>
    </project></mappingtool>"""
    inner_buf = io.BytesIO()
    with zipfile.ZipFile(inner_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata", mt_xml)
    outer_buf = io.BytesIO()
    with zipfile.ZipFile(outer_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("value", inner_buf.getvalue())
    b64 = base64.b64encode(outer_buf.getvalue()).decode("ascii")

    xi_trafo = f"""<?xml version="1.0" encoding="UTF-8"?>
<p1:xiObj xmlns:p1="urn:sap-com:xi" xmlns:tr="urn:sap-com:xi:mapping:xitrafo">
  <p1:idInfo VID="v1"><p1:key typeID="XI_TRAFO" oid="mm001">
    <p1:elem>MM_Order_Sync</p1:elem><p1:elem>urn:sample:orders</p1:elem>
  </p1:key></p1:idInfo>
  <p1:content><tr:XiTrafo><tr:MetaData><tr:blob>!zip!{b64}</tr:blob></tr:MetaData></tr:XiTrafo></p1:content>
</p1:xiObj>""".encode("utf-8")

    # Add sensitive channel + large documentation objects to comfortably exceed the 1 MiB chunk boundary
    ch = _make_channel_xml(
        "ch_mc_1", "BC_EXT", "CC_EXT_REST_RCV",
        "https://api.internal.corp:9443/v2/orders?env=prod",
        "urn:orders:submit",
    )
    pad_block = ("Contact admin@corp.example.org or host 192.168.55.12 for escalation. " * 2500)
    docs = [
        f"""<?xml version="1.0" encoding="UTF-8"?>
<p1:xiObj xmlns:p1="urn:sap-com:xi">
  <p1:idInfo VID="d{i}"><p1:key typeID="DOCU" oid="doc{i:03d}">
    <p1:elem>DOC_SPEC_{i}</p1:elem><p1:elem>urn:sample:orders</p1:elem>
  </p1:key></p1:idInfo>
  <p1:content><DocText><Note>{pad_block}</Note></DocText></p1:content>
</p1:xiObj>""".encode("utf-8")
        for i in range(8)
    ]

    tpt = _build_tpt_bytes([ch, xi_trafo] + docs, cat_mode="stream_crc")
    dlt = _build_tpt_bytes([ch], cat_mode="cat_crc")
    return _pack_tpz({
        "Metadata.properties": b"swcv=SAMPLE_ESR 1.0\n",
        "primary.tpt": tpt,
        "delta.dlt": dlt,
    })


class TestTptCodec(unittest.TestCase):
    def test_channel_patch_repack_and_reload(self):
        raw = _make_sample_channels_tpz()

        ver = verify_tpz_bytes(raw)
        self.assertTrue(ver["allVerified"])

        new_url = "https://qa-repacked-endpoint.example.local/PosPaymentListV2_LongerPath"
        repacked, summary = repack_tpz_bytes(
            raw,
            channel_patches=[
                {
                    "channelName": "CC_SOAP_PAYMENT_LIST_RCV",
                    "attribute": "XMBWS.DefaultSOAPAction",
                    "value": new_url,
                }
            ],
        )
        self.assertGreaterEqual(summary["totalEdits"], 1)

        # Verify repacked archive CRC32 + catalog offsets
        ver2 = verify_tpz_bytes(repacked)
        self.assertTrue(ver2["allVerified"], ver2)

        # Reload into LocalTpzEngine and verify mutated channel attribute + untouched sibling channels
        eng = LocalTpzEngine()
        loaded = eng.load_tpz_bytes("sample_channels_repacked.tpz", repacked)
        self.assertEqual(loaded["stats"]["channels"], 3)
        self.assertEqual(loaded["warnings"], [])

        ch_obj = next(o for o in loaded["objects"] if o["name"] == "CC_SOAP_PAYMENT_LIST_RCV")
        det = eng.get_object_detail(ch_obj["id"])
        soap_action = next(a["value"] for a in det["channel"]["attributes"] if a["name"] == "XMBWS.DefaultSOAPAction")
        self.assertEqual(soap_action, new_url)

    def test_multichunk_sanitize_shifts_1mib_boundary_and_stays_valid(self):
        raw = _make_multichunk_tpz()

        eng_orig = LocalTpzEngine()
        orig_loaded = eng_orig.load_tpz_bytes("sample_multichunk.tpz", raw)

        sanitized, summary = repack_tpz_bytes(raw, sanitize=True)
        self.assertGreater(summary["totalEdits"], 0)
        self.assertNotEqual(len(sanitized), len(raw))

        ver = verify_tpz_bytes(sanitized)
        self.assertTrue(ver["allVerified"], ver)
        self.assertGreaterEqual(ver["containers"][0]["chunksChecked"], 1)
        self.assertEqual(ver["containers"][0]["chunksOk"], ver["containers"][0]["chunksChecked"])

        eng_new = LocalTpzEngine()
        new_loaded = eng_new.load_tpz_bytes("sample_multichunk_sanitized.tpz", sanitized)
        self.assertEqual(new_loaded["stats"]["totalObjects"], orig_loaded["stats"]["totalObjects"])
        self.assertEqual(new_loaded["stats"]["fieldMappings"], orig_loaded["stats"]["fieldMappings"])
        self.assertEqual(new_loaded["warnings"], [])

    def test_multiblock_stream_and_cat_crc_bit_exact_roundtrip(self):
        raw = _make_multichunk_tpz()
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            modes_seen = set()
            for name in zf.namelist():
                if name.endswith((".tpt", ".dlt")):
                    orig = zf.read(name)
                    parsed = unchunk_tpt(orig)
                    self.assertTrue(parsed.report.verified, parsed.report.errors)
                    modes_seen.add(parsed.cat_mode)
                    rebuilt = rechunk_tpt(parsed.logical, parsed.catalog_xml, parsed.cat_mode)
                    self.assertEqual(rebuilt, orig)
            self.assertEqual(modes_seen, {"stream_crc", "cat_crc"})


class TestRepackHttpEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        GLOBAL_ENGINE.archives.clear()
        GLOBAL_ENGINE.archive_bytes.clear()
        GLOBAL_ENGINE.objects.clear()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), TpzStudioHandler)
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_http_verify_and_repack_endpoints(self):
        raw = _make_sample_channels_tpz()
        loaded = GLOBAL_ENGINE.load_tpz_bytes("sample_channels.tpz", raw)
        arch_id = loaded["archiveId"]

        # GET /api/archives/{id}/verify
        with urllib.request.urlopen(f"{self.base}/api/archives/{arch_id}/verify", timeout=5) as r:
            ver = json.loads(r.read().decode("utf-8"))
            self.assertTrue(ver["allVerified"])
            self.assertEqual(ver["containers"][0]["catMode"], "stream_crc")

        # POST /api/archives/{id}/repack
        payload = json.dumps({
            "sanitize": True,
            "channelPatches": [
                {
                    "channelName": "CC_SOAP_PAYMENT_LIST_RCV",
                    "attribute": "XMBWS.DefaultSOAPAction",
                    "value": "https://clean.example.local/action",
                }
            ],
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base}/api/archives/{arch_id}/repack",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            out_bytes = r.read()
            disp = r.headers.get("Content-Disposition", "")
            summary = json.loads(r.headers.get("X-TPZ-Repack-Summary", "{}"))
            self.assertIn("_sanitized.tpz", disp)
            self.assertGreater(summary["totalEdits"], 0)
            self.assertTrue(verify_tpz_bytes(out_bytes)["allVerified"])

    def test_multiblock_catalog_roundtrip_and_repack(self):
        """Verify multi-block catalog continuing across >1 MiB boundaries (2 catalog markers) + length-changing repack."""
        header_xml = b'<?xml version="1.0" encoding="UTF-8"?><header><sourcesystem>S4P</sourcesystem></header>'
        hdr_seg = struct.pack(">QII", 8 + len(header_xml), 0, zlib.crc32(header_xml) & 0xFFFFFFFF) + header_xml

        logical = bytearray(TPT_MAGIC + b"\x00" * 30)
        cat_parts = [f'<segment type="header" offset="38" length="{len(hdr_seg)}"/>']
        logical.extend(hdr_seg)

        obj_parts = []
        sample_xml = b'<?xml version="1.0"?><p1:xiObj><modifBy>ORIG_USER</modifBy></p1:xiObj>'
        me_rec = struct.pack(">Q", len(sample_xml)) + sample_xml
        for _ in range(35000):
            off = len(logical)
            logical.extend(me_rec)
            obj_parts.append(f'<segment type="modelElement" offset="{off}" length="{len(me_rec)}"/>')

        cat_xml = (
            '<?xml version="1.0" encoding="UTF-8"?><catalog><segments>'
            + "".join(cat_parts)
            + "<objectList>"
            + "".join(obj_parts)
            + "</objectList></segments></catalog>\n"
        ).encode("utf-8")

        raw = rechunk_tpt(bytes(logical), cat_xml, cat_mode="stream_crc")
        parsed = unchunk_tpt(raw)
        self.assertTrue(parsed.report.verified, parsed.report.errors)
        self.assertGreaterEqual(parsed.report.cat_markers_checked, 2)
        self.assertEqual(parsed.report.cat_markers_ok, parsed.report.cat_markers_checked)
        self.assertEqual(rechunk_tpt(parsed.logical, parsed.catalog_xml, parsed.cat_mode), raw)

        # Length-changing edit that shifts BOTH body tail AND first_gap inside catalog!
        def edit_first(xml_str: str):
            if "ORIG_USER" in xml_str:
                return xml_str.replace("ORIG_USER", "MULTIBLOCK_REPACK_VERIFIED_2026", 1), 1
            return xml_str, 0

        repacked, stats = repack_tpt(raw, transform_model_xml=edit_first)
        self.assertEqual(stats["totalEdits"], 35000)
        recheck = unchunk_tpt(repacked)
        self.assertTrue(recheck.report.verified, recheck.report.errors)
        self.assertEqual(recheck.report.cat_markers_ok, recheck.report.cat_markers_checked)
        self.assertGreaterEqual(recheck.report.cat_markers_checked, 2)
        self.assertIn(b"MULTIBLOCK_REPACK_VERIFIED_2026", recheck.logical)

    def test_versionset_uuid_chain_pvcversionset_and_known_devlines(self):
        """Verify network-byte-order header/versionSet@id == pvcVersionSet TLV1 == V3 == R16 + knownDevlines R3 join."""
        from tpt_codec import (
            extract_header_versionset_id,
            format_uuid_dashed,
            parse_known_devlines_tlvs,
            parse_pvc_element_tlvs,
            parse_pvc_version_set_tlvs,
            parse_pvc_vset_specialization_tlvs,
        )

        def tlv(b: bytes) -> bytes:
            return struct.pack(">I", len(b)) + b

        vset_hex = "112233445566778899aabbccddeeff00"
        vset_dashed = format_uuid_dashed(vset_hex)
        # Mixed-endian GUID bytes would reverse the first 3 fields and MUST NOT match!
        mixed_endian_hex = "443322116655887799aabbccddeeff00"
        self.assertNotEqual(vset_hex, mixed_endian_hex)

        oid_hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
        vid_hex = "f0e1d2c3b4a5968778695a4b3c2d1e0f"
        branch_hex = "0102030405060708090a0b0c0d0e0f10"
        devline_hex = "aa11bb22cc33dd44ee55ff6600778899"
        creator_vsid = bytes.fromhex("102030405060708090a0b0c0d0e0f001")
        rel_id = bytes.fromhex(branch_hex)
        ts_ms = 1763625600000  # epoch-ms

        header_xml = (
            f'<?xml version="1.0" encoding="UTF-8"?>'
            f'<header><sourcesystem>DEV</sourcesystem>'
            f'<versionSet id="{vset_dashed}"/></header>'
        ).encode("utf-8")
        self.assertEqual(extract_header_versionset_id(header_xml), vset_hex)
        hdr_seg = struct.pack(">QII", 8 + len(header_xml), 0, zlib.crc32(header_xml) & 0xFFFFFFFF) + header_xml

        # Build pvcElement: 4B version + 16 TLVs + u32(1) + 18 TLVs (including populated tail R15..R18)
        pvc_prologue = [
            bytes.fromhex(oid_hex),      # F1 objectID
            struct.pack(">I", 1),        # F2 modelID
            b"7.50",                     # F3 modelVersion
            struct.pack(">I", 42),       # F4 objectType
            struct.pack(">I", 0),        # F5 propConfinement
            bytes.fromhex(vid_hex),      # F6 versionID
            bytes.fromhex(oid_hex),      # F7 objectID repeat
            bytes.fromhex(branch_hex),   # F8 branchIdCandidate
            struct.pack(">I", 7),        # F9 branchSeqNo
            struct.pack(">I", 1),        # F10 objState
            struct.pack(">I", 0),        # F11 isDeleted
            b"DEV_USER",                 # F12 creatorName
            struct.pack(">q", ts_ms),    # F13 creationTime
            struct.pack(">q", ts_ms + 5000),  # F14 lastModified (differs from F13!)
            struct.pack(">I", 0),        # F15 isArchived
            struct.pack(">I", 0),        # F16 versionType
        ]
        pvc_rel_row = [
            rel_id,                      # R1 relationID
            creator_vsid,                # R2 creatorVSID
            bytes.fromhex(devline_hex),  # R3 ownerVSID -> matches knownDevlines F1!
            bytes.fromhex(oid_hex),      # R4 objectID
            b"",                         # R5 predVID
            b"",                         # R6 predBRID
            struct.pack(">I", 0),        # R7 predSeqNo
            bytes.fromhex(vid_hex),      # R8 succVID
            bytes.fromhex(branch_hex),   # R9 succBRID
            struct.pack(">I", 7),        # R10 succSeqNo
            struct.pack(">I", 42),       # R11 objType
            struct.pack(">I", 1),        # R12 objState
            b"DEV_USER",                 # R13 creatorName
            struct.pack(">q", ts_ms),    # R14 creationTime
            rel_id,                      # R15 referenced relationID
            bytes.fromhex(vset_hex),     # R16 versionSetID == header/versionSet@id!
            struct.pack(">I", 171),      # R17 variable BE uint32 (observed: 1, 171, 290)
            b"DEV_USER",                 # R18 == R13
        ]
        pvc_bytes = (
            struct.pack(">I", 2)
            + b"".join(tlv(x) for x in pvc_prologue)
            + struct.pack(">I", 1)
            + b"".join(tlv(x) for x in pvc_rel_row)
        )
        parsed_pvc = parse_pvc_element_tlvs(pvc_bytes)
        self.assertIsNotNone(parsed_pvc)
        self.assertTrue(parsed_pvc["exactConsumed"])
        self.assertEqual(parsed_pvc["tailVersionSetIds"], [vset_hex])
        self.assertEqual(parsed_pvc["ownerVsIds"], [devline_hex])
        self.assertEqual(parsed_pvc["r17Values"], [171])

        # Build pvcVersionSet: 4B preamble + 16 TLVs + u32(1) + 9 TLVs (16,16,16,4,4,8,8,4,4)
        vset_prologue = [
            bytes.fromhex(vset_hex),     # TLV1 == header/versionSet@id
            bytes.fromhex(devline_hex),  # TLV2 (baseVersionSetID candidate) == knownDevlines.K1!
        ] + [b""] * 14
        vset_row = [
            bytes.fromhex(vid_hex),      # V1 VID
            bytes.fromhex(oid_hex),      # V2 OID
            bytes.fromhex(vset_hex),     # V3 VersionSet ID
            struct.pack(">I", 1),        # V4
            struct.pack(">I", 0),        # V5
            struct.pack(">q", ts_ms),    # V6
            struct.pack(">q", ts_ms),    # V7 == V6
            struct.pack(">I", 0),        # V8
            struct.pack(">I", 0),        # V9
        ]
        vset_bytes = (
            struct.pack(">I", 1)
            + b"".join(tlv(x) for x in vset_prologue)
            + struct.pack(">I", 1)
            + b"".join(tlv(x) for x in vset_row)
        )
        parsed_vset = parse_pvc_version_set_tlvs(vset_bytes)
        self.assertIsNotNone(parsed_vset)
        self.assertTrue(parsed_vset["exactConsumed"])
        self.assertEqual(parsed_vset["versionSetId"], vset_hex)
        self.assertEqual(parsed_vset["duplicateVids"], 0)
        self.assertEqual(parsed_vset["rowsMatchingFirstTlv"], 1)

        # Build pvcVersionSetSpecialization: 4B preamble(1) + TLV1(16B vset UUID) + TLV2(4B specCode=2)
        vset_spec_bytes = struct.pack(">I", 1) + tlv(bytes.fromhex(vset_hex)) + tlv(struct.pack(">I", 2))
        parsed_spec = parse_pvc_vset_specialization_tlvs(vset_spec_bytes)
        self.assertIsNotNone(parsed_spec)
        self.assertTrue(parsed_spec["exactConsumed"])
        self.assertEqual(parsed_spec["versionSetId"], vset_hex)
        self.assertEqual(parsed_spec["specCode"], 2)

        # Build knownDevlines: BE u32(1) + 5 TLVs (16, 8, 16, var, var)
        dl_bytes = struct.pack(">I", 1) + b"".join([
            tlv(bytes.fromhex(devline_hex)),
            tlv(struct.pack(">Q", 1001)),
            tlv(bytes.fromhex("cc" * 16)),
            tlv(b"SAP_BASIS_750_DEVLINE"),
            tlv(b"MAIN"),
        ])
        parsed_dl = parse_known_devlines_tlvs(dl_bytes)
        self.assertIsNotNone(parsed_dl)
        self.assertTrue(parsed_dl["exactConsumed"])
        self.assertIn(devline_hex, parsed_dl["byId"])

        # Model element whose OID & VID match the PVC & membership rows
        model_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<p1:xiObj xmlns:p1="urn:sap-com:xi">
  <p1:idInfo VID="{format_uuid_dashed(vid_hex)}"><p1:key typeID="ifmtypedef" oid="{format_uuid_dashed(oid_hex)}">
    <p1:elem>DT_Order</p1:elem><p1:elem>urn:sample:orders</p1:elem>
  </p1:key></p1:idInfo>
  <p1:content><DataType/></p1:content>
</p1:xiObj>""".encode("utf-8")
        me_seg = struct.pack(">Q", len(model_xml)) + model_xml

        logical = bytearray(TPT_MAGIC + b"\x00" * 30)
        cat_entries = []

        def add_seg(seg_type: str, payload: bytes, in_obj: bool = False):
            off = len(logical)
            logical.extend(payload)
            cat_entries.append((in_obj, f'<segment type="{seg_type}" offset="{off}" length="{len(payload)}"/>'))

        add_seg("header", hdr_seg, False)
        add_seg("pvcVersionSet", vset_bytes, False)
        add_seg("pvcVersionSetSpecialization", vset_spec_bytes, False)
        add_seg("knownDevlines", dl_bytes, False)
        add_seg("pvcElement", pvc_bytes, True)
        add_seg("modelElement", me_seg, True)

        top_segs = "".join(tag for in_obj, tag in cat_entries if not in_obj)
        obj_segs = "".join(tag for in_obj, tag in cat_entries if in_obj)
        cat_xml = (
            f'<?xml version="1.0" encoding="UTF-8"?><catalog version="2.1"><segments>'
            f"{top_segs}<objectList>{obj_segs}</objectList></segments></catalog>\n"
        ).encode("utf-8")

        tpt_raw = rechunk_tpt(bytes(logical), cat_xml, cat_mode="stream_crc")
        parsed = unchunk_tpt(tpt_raw)
        rep = parsed.report
        self.assertTrue(rep.verified, rep.errors)
        self.assertEqual(rep.header_version_set_id, vset_dashed)
        self.assertTrue(rep.vset_first_tlv_matches_header)
        self.assertEqual(rep.vset_second_tlv_id, format_uuid_dashed(devline_hex))
        self.assertTrue(rep.vset_second_tlv_in_devlines)
        self.assertEqual(rep.vset_second_tlv_devline_label, "SAP_BASIS_750_DEVLINE")
        self.assertEqual(rep.vset_spec_code, 2)
        self.assertTrue(rep.vset_spec_matches_header)
        self.assertEqual(rep.vset_membership_rows, 1)
        self.assertEqual(rep.vset_membership_matches_header, 1)
        self.assertEqual(rep.vset_membership_joined_pvc, 1)
        self.assertEqual(rep.pvc_r16_total, 1)
        self.assertEqual(rep.pvc_r16_matches_header, 1)
        self.assertEqual(rep.known_devlines_count, 1)
        self.assertEqual(rep.pvc_r3_total, 1)
        self.assertEqual(rep.pvc_r3_resolved_devlines, 1)

        # Load into LocalTpzEngine and verify object detail carries full joined PVC metadata
        tpz_raw = _pack_tpz({"primary.tpt": tpt_raw})
        ver_tpz = verify_tpz_bytes(tpz_raw)
        self.assertTrue(ver_tpz["allVerified"])
        self.assertIn("zipFlagBit3", ver_tpz["containers"][0])
        self.assertEqual(ver_tpz["containers"][0]["vsetSecondTlvDevlineLabel"], "SAP_BASIS_750_DEVLINE")
        eng = LocalTpzEngine()
        loaded = eng.load_tpz_bytes("pvc_vset_test.tpz", tpz_raw)
        self.assertEqual(len(loaded["objects"]), 1)
        det = eng.get_object_detail(loaded["objects"][0]["id"])
        pvc_info = det["pvcInfo"]
        self.assertIsNotNone(pvc_info)
        self.assertEqual(pvc_info["headerVersionSetId"], vset_dashed)
        self.assertTrue(pvc_info["r16MatchesHeader"])
        self.assertTrue(pvc_info["membership"]["matchesHeader"])
        self.assertEqual(pvc_info["membership"]["v4"], 1)
        self.assertTrue(pvc_info["membership"]["v6v7Equal"])
        self.assertEqual(pvc_info["devlines"][0]["field4"], "SAP_BASIS_750_DEVLINE")

    def test_r3_row_occurrence_counting_and_cross_archive_devline_resolution(self):
        """Verify per-row R3 occurrence metrics, external unresolved R3 tracking, and complementary-TPZ cross-archive lookup."""
        from tpt_codec import format_uuid_dashed

        def tlv(b: bytes) -> bytes:
            return struct.pack(">I", len(b)) + b

        oid_hex = "11112222333344445555666677778888"
        vid_hex = "9999aaaabbbbccccddddeeeeffff0000"
        local_dl_hex = "aaaa0000bbbb1111cccc2222dddd3333"
        ext_dl_hex = "eeee4444ffff55550000666611117777"
        ext_dl_dashed = format_uuid_dashed(ext_dl_hex)

        def make_rel_row(r3_hex: str) -> bytes:
            row = [
                bytes.fromhex("01" * 16),  # R1
                bytes.fromhex("02" * 16),  # R2
                bytes.fromhex(r3_hex),     # R3 ownerVSID
                bytes.fromhex(oid_hex),    # R4
                b"", b"", struct.pack(">I", 0),
                bytes.fromhex(vid_hex), bytes.fromhex("01" * 16), struct.pack(">I", 1),
                struct.pack(">I", 1), struct.pack(">I", 2), b"USER", struct.pack(">q", 1763625600000),
                b"", b"", b"", b"",
            ]
            return b"".join(tlv(x) for x in row)

        prologue = [
            bytes.fromhex(oid_hex), struct.pack(">I", 1), b"7.50", struct.pack(">I", 1), struct.pack(">I", 0),
            bytes.fromhex(vid_hex), bytes.fromhex(oid_hex), bytes.fromhex("01" * 16),
            struct.pack(">I", 1), struct.pack(">I", 2), struct.pack(">I", 0),
            b"USER", struct.pack(">q", 1763625600000), struct.pack(">q", 1763625600000),
            struct.pack(">I", 0), struct.pack(">I", 0),
        ]
        # 3 relation rows: 2 reference local_dl_hex + 1 references unexported ext_dl_hex
        pvc_bytes = (
            struct.pack(">I", 2)
            + b"".join(tlv(x) for x in prologue)
            + struct.pack(">I", 3)
            + make_rel_row(local_dl_hex)
            + make_rel_row(local_dl_hex)
            + make_rel_row(ext_dl_hex)
        )
        local_dl_bytes = struct.pack(">I", 1) + b"".join([
            tlv(bytes.fromhex(local_dl_hex)),
            tlv(struct.pack(">Q", 1)),
            tlv(bytes.fromhex("aa" * 16)),
            tlv(b"LOCAL_DEVLINE"),
            tlv(b"MAIN"),
        ])
        comp_dl_bytes = struct.pack(">I", 1) + b"".join([
            tlv(bytes.fromhex(ext_dl_hex)),
            tlv(struct.pack(">Q", 2)),
            tlv(bytes.fromhex("bb" * 16)),
            tlv(b"COMPLEMENTARY_BASIS_DL"),
            tlv(b"BASIS"),
        ])

        def build_container(dl_bytes: bytes, with_pvc: bool) -> bytes:
            hdr_xml = b'<?xml version="1.0" encoding="UTF-8"?><header><sourcesystem>DEV</sourcesystem></header>'
            hdr_seg = struct.pack(">QII", 8 + len(hdr_xml), 0, zlib.crc32(hdr_xml) & 0xFFFFFFFF) + hdr_xml
            logical = bytearray(TPT_MAGIC + b"\x00" * 30)
            top, objs = [], []

            def add(t: str, payload: bytes, in_obj: bool = False):
                off = len(logical)
                logical.extend(payload)
                (objs if in_obj else top).append(f'<segment type="{t}" offset="{off}" length="{len(payload)}"/>')

            add("header", hdr_seg, False)
            add("knownDevlines", dl_bytes, False)
            if with_pvc:
                add("pvcElement", pvc_bytes, True)
                xml = f"""<?xml version="1.0" encoding="UTF-8"?><p1:xiObj xmlns:p1="urn:sap-com:xi">
                  <p1:idInfo VID="{format_uuid_dashed(vid_hex)}"><p1:key typeID="ifmtypedef" oid="{format_uuid_dashed(oid_hex)}">
                    <p1:elem>DT_ExtRef</p1:elem><p1:elem>urn:sample</p1:elem>
                  </p1:key></p1:idInfo><p1:content><DataType/></p1:content></p1:xiObj>""".encode("utf-8")
                add("modelElement", struct.pack(">Q", len(xml)) + xml, True)
            cat_xml = (
                f'<?xml version="1.0" encoding="UTF-8"?><catalog version="2.1"><segments>'
                f'{"".join(top)}<objectList>{"".join(objs)}</objectList></segments></catalog>\n'
            ).encode("utf-8")
            return rechunk_tpt(bytes(logical), cat_xml, cat_mode="stream_crc")

        main_tpt = build_container(local_dl_bytes, with_pvc=True)
        parsed = unchunk_tpt(main_tpt)
        self.assertTrue(parsed.report.verified, parsed.report.errors)
        # True per-row occurrence counts: 2 resolved + 1 unresolved = 3 total rows (NOT 2 unique IDs!)
        self.assertEqual(parsed.report.pvc_r3_total, 3)
        self.assertEqual(parsed.report.pvc_r3_resolved_devlines, 2)
        self.assertEqual(parsed.report.pvc_r3_unresolved_unique, 1)
        self.assertEqual(parsed.report.pvc_r3_unresolved_ids, [ext_dl_dashed])

        eng = LocalTpzEngine()
        main_loaded = eng.load_tpz_bytes("main_export.tpz", _pack_tpz({"main.tpt": main_tpt}))
        obj_id = main_loaded["objects"][0]["id"]

        # Before loading complementary TPZ: local devline resolved, external R3 listed as unresolved
        det_before = eng.get_object_detail(obj_id)
        self.assertEqual(det_before["pvcInfo"]["devlines"][0]["field4"], "LOCAL_DEVLINE")
        self.assertEqual(det_before["pvcInfo"]["unresolvedOwnerVsIds"], [ext_dl_dashed])
        self.assertNotIn("crossArchiveDevlines", det_before["pvcInfo"])

        # After loading complementary TPZ exporting ext_dl_hex: resolved cross-archive!
        comp_tpt = build_container(comp_dl_bytes, with_pvc=False)
        comp_loaded = eng.load_tpz_bytes("complementary_basis.tpz", _pack_tpz({"basis.tpt": comp_tpt}))
        det_after = eng.get_object_detail(obj_id)
        self.assertEqual(det_after["pvcInfo"]["unresolvedOwnerVsIds"], [])
        self.assertEqual(det_after["pvcInfo"]["crossArchiveDevlines"][0]["field4"], "COMPLEMENTARY_BASIS_DL")
        self.assertEqual(det_after["pvcInfo"]["crossArchiveDevlines"][0]["sourceArchive"], "complementary_basis.tpz")
        self.assertEqual(det_after["pvcInfo"]["crossArchiveDevlines"][0]["scope"], "workspace")

        # Removing complementary TPZ cleanly reverts to unresolved state
        eng.remove_archive(comp_loaded["archiveId"])
        det_reverted = eng.get_object_detail(obj_id)
        self.assertEqual(det_reverted["pvcInfo"]["unresolvedOwnerVsIds"], [ext_dl_dashed])


if __name__ == "__main__":
    unittest.main()
