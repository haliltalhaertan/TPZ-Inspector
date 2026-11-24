#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import base64
import io
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from engine import LocalTpzEngine, parse_mappingtool_xml, scan_xi_objects_from_slice  # noqa: E402
from standalone_server import ENGINE as GLOBAL_ENGINE, TpzStudioHandler  # noqa: E402


def _make_zip_bytes(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _make_sample_tpz_bytes() -> bytes:
    mt_xml = b"""<mappingtool><project>
      <libstorage><entry name="usernamespace"><functionstorage>
        <functionmodel>
          <signature cacheType="value"><argument nm="val" jtp="String"/></signature>
          <name>cleanCode</name><key>udf-99</key><title>Clean Code</title>
          <implementation type="udf"><javaText><![CDATA[return val.trim();]]></javaText></implementation>
        </functionmodel>
      </functionstorage></entry></libstorage>
      <transformation>
        <brick type="Dst" path="/Target/Status">
          <arg pin="0">
            <brick type="Func" fname="udf-99" fns="usernamespace">
              <arg pin="0"><brick type="Src" path="/Source/RawStatus"/></arg>
            </brick>
          </arg>
        </brick>
      </transformation>
    </project></mappingtool>"""
    inner_val = _make_zip_bytes({"metadata": mt_xml})
    outer_blob = _make_zip_bytes({"value": inner_val})
    b64 = base64.b64encode(outer_blob).decode("ascii")

    xi_trafo = f"""<p1:xiObj xmlns:p1="urn:sap-com:xi" xmlns:tr="urn:sap-com:xi:mapping:xitrafo">
      <p1:idInfo VID="1"><p1:key typeID="XI_TRAFO" oid="oid1">
        <p1:elem>MM_Test</p1:elem><p1:elem>urn:demo</p1:elem>
      </p1:key></p1:idInfo>
      <p1:content><tr:XiTrafo><tr:MetaData><tr:blob>!zip!{b64}</tr:blob></tr:MetaData></tr:XiTrafo></p1:content>
    </p1:xiObj>""".encode("utf-8")

    xi_chan = b"""<p1:xiObj xmlns:p1="urn:sap-com:xi" xmlns:ns1="urn:sap-com:xi:xiChannel">
      <p1:idInfo VID="2"><p1:key typeID="Channel" oid="oid2">
        <p1:elem/><p1:elem>BS_ERP</p1:elem><p1:elem>CC_SOAP_RCV</p1:elem>
      </p1:key></p1:idInfo>
      <p1:generic><p1:lnks>
        <p1:lnkRole role="ADAPTER"><p1:lnk><p1:key typeID="AdapterMetaData" oid="a1">
          <p1:elem>SOAP</p1:elem><p1:elem>http://sap.com/xi/XI/System</p1:elem>
        </p1:key></p1:lnk></p1:lnkRole>
      </p1:lnks></p1:generic>
      <p1:content><ns1:Channel>
        <ns1:ChannelDirection>O</ns1:ChannelDirection>
        <ns1:TransportProtocol>HTTP</ns1:TransportProtocol>
        <ns1:MessageProtocol>SOAP</ns1:MessageProtocol>
        <ns1:ChannelAttributes><AdapterTypeData>
          <Attribute><Name>XMBWS.TargetURL</Name><Value>https://api.example.com/soap</Value></Attribute>
        </AdapterTypeData></ns1:ChannelAttributes>
      </ns1:Channel></p1:content>
    </p1:xiObj>"""

    xi_ico = b"""<p1:xiObj xmlns:p1="urn:sap-com:xi">
      <p1:idInfo VID="3"><p1:key typeID="AllInOne" oid="oid3">
        <p1:elem/><p1:elem>BS_SENDER</p1:elem><p1:elem>http://demo.com/ns</p1:elem><p1:elem>SI_ORDER_OUT</p1:elem><p1:elem/><p1:elem/>
      </p1:key></p1:idInfo>
      <p1:generic><p1:lnks>
        <p1:lnkRole role="receiverChannel"><p1:lnk><p1:key typeID="Channel" oid="oid2">
          <p1:elem/><p1:elem>BS_ERP</p1:elem><p1:elem>CC_SOAP_RCV</p1:elem>
        </p1:key></p1:lnk></p1:lnkRole>
      </p1:lnks></p1:generic>
      <p1:content><AllInOne version="130"/></p1:content>
    </p1:xiObj>"""

    return _make_zip_bytes({
        "Metadata.properties": b"swcv=DEMO_SWCV 1.0\n",
        "primary.tpt": xi_trafo + b"\n" + xi_chan,
        "delta.dlt": xi_ico,
    })


class TestTpzViewerEngine(unittest.TestCase):
    def test_depth_aware_nested_xiobj_and_nul_repair(self):
        # Test both mid-tag split header AND NUL padding directly before <p1:xiObj
        nested_stream = (
            b"\x00" * 36
            + b'<p1:xiObj xmlns:p1="urn:sap-com:xi">'
            b'<p1:idInfo VID="v1"><p1:key typeID="ifmmessif" oid="o1"><p1:elem>SI_Order</p1:elem><p1:elem>urn:test</p1:elem></p1:key></p1:idInfo>'
            b'<p1:inner><p1:xiObj xmlns:p1="urn:sap-com:xi">'
            b'<p1:idInfo VID="v2"><p1:key typeID="DOCU" oid="o2"><p1:elem>Doc</p1:elem></p1:key></p1:idInfo>'
            b'</p1:xiObj></p1:inner>'
            b'</p1:xiO\x00\x00\x00\x00ABCDbj>'
        )
        objs = scan_xi_objects_from_slice(nested_stream)
        self.assertEqual(len(objs), 1)
        self.assertTrue(objs[0].startswith(b"<p1:xiObj"))
        self.assertTrue(objs[0].endswith(b"</p1:xiObj>"))

    def test_brick_and_udf_mappingtool(self):
        mt_xml = b"""<mappingtool version="XI7.1"><project>
          <libstorage><entry name="usernamespace"><functionstorage>
            <functionmodel>
              <signature cacheType="value"><argument nm="inVal" jtp="String"/></signature>
              <name>trimZeros</name><key>udf-123</key><title>Trim Zeros</title>
              <implementation type="udf"><javaText><![CDATA[return inVal.replaceFirst("^0+", "");]]></javaText></implementation>
            </functionmodel>
          </functionstorage></entry></libstorage>
          <transformation>
            <brick type="Dst" path="/Order/ID">
              <arg pin="0">
                <brick type="Func" fname="udf-123" fns="usernamespace">
                  <arg pin="0"><brick type="Src" path="/IDOC/BELNR"/></arg>
                </brick>
              </arg>
            </brick>
          </transformation>
        </project></mappingtool>"""
        parsed = parse_mappingtool_xml(mt_xml)
        self.assertEqual(len(parsed["udfs"]), 1)
        self.assertEqual(parsed["udfs"][0]["name"], "trimZeros")
        self.assertEqual(len(parsed["fieldMappings"]), 1)
        fm = parsed["fieldMappings"][0]
        self.assertEqual(fm["targetPath"], "/Order/ID")
        self.assertIn("trimZeros(/IDOC/BELNR)", fm["expression"])
        self.assertEqual(fm["udfs"], ["trimZeros"])

    def test_legacy_destpath_schema(self):
        legacy_xml = b"""<mappingtool><project>
          <mapping destPath="/Fault/Name">
            <model classname="DestinationValue">
              <link>
                <model classname="Function" name="const" namespace="dflt">
                  <parameter><name>value</name><default>FAILED</default></parameter>
                </model>
              </link>
            </model>
          </mapping>
        </project></mappingtool>"""
        parsed = parse_mappingtool_xml(legacy_xml)
        self.assertEqual(len(parsed["fieldMappings"]), 1)
        self.assertEqual(parsed["fieldMappings"][0]["targetPath"], "/Fault/Name")
        self.assertEqual(parsed["fieldMappings"][0]["constants"], ["FAILED"])
        self.assertEqual(parsed["fieldMappings"][0]["schemaFormat"], "legacy_destPath")

    def test_ico_and_channel_positional_keys_and_links(self):
        tpz_bytes = _make_sample_tpz_bytes()
        eng = LocalTpzEngine()
        summary = eng.load_tpz_bytes("DEMO.tpz", tpz_bytes)
        self.assertEqual(summary["stats"]["totalObjects"], 3)
        ico = [o for o in summary["objects"] if o["typeId"] == "AllInOne"][0]
        self.assertEqual(ico["name"], "BS_SENDER → SI_ORDER_OUT")
        self.assertEqual(ico["namespace"], "http://demo.com/ns")
        ico_det = eng.get_object_detail(ico["id"])
        self.assertEqual(ico_det["links"][0]["targetName"], "CC_SOAP_RCV")


class TestStandaloneHttpServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        GLOBAL_ENGINE.archives.clear()
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

    def test_full_http_lifecycle_including_turkish_filename_upload(self):
        # 1) Health check
        with urllib.request.urlopen(f"{self.base}/api/health", timeout=5) as r:
            h = json.loads(r.read().decode("utf-8"))
            self.assertTrue(h["ok"])

        # 2) Multipart upload with Turkish UTF-8 filename (HAKEDİS.tpz)
        tpz_raw = _make_sample_tpz_bytes()
        boundary = "----TPZTestBoundary9912"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="files"; filename="HAKEDİS.tpz"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8") + tpz_raw + f"\r\n--{boundary}--\r\n".encode("utf-8")

        req = urllib.request.Request(
            f"{self.base}/api/archives/upload",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            up = json.loads(r.read().decode("utf-8"))
            self.assertEqual(len(up["loaded"]), 1)
            self.assertEqual(up["loaded"][0]["fileName"], "HAKEDİS.tpz")
            arch_id = up["loaded"][0]["archiveId"]
            objs = up["loaded"][0]["objects"]

        # 3) Inspect every object over HTTP
        for o in objs:
            with urllib.request.urlopen(f"{self.base}/api/objects/{o['id']}", timeout=5) as r:
                det = json.loads(r.read().decode("utf-8"))
                self.assertEqual(det["id"], o["id"])

        # 4) Global search over HTTP
        with urllib.request.urlopen(f"{self.base}/api/search?q=api.example.com", timeout=5) as r:
            sr = json.loads(r.read().decode("utf-8"))
            self.assertEqual(len(sr["channels"]), 1)

        # 5) Invalid upload returns clean JSON 400 without dropping TCP connection
        bad_body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="files"; filename="corrupt.tpz"\r\n\r\n'
            f"NOT_A_ZIP_FILE\r\n--{boundary}--\r\n"
        ).encode("utf-8")
        bad_req = urllib.request.Request(
            f"{self.base}/api/archives/upload",
            data=bad_body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(bad_req, timeout=5)
        self.assertEqual(ctx.exception.code, 400)
        err_json = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertIn("Invalid TPZ", err_json["detail"])

        # 6) Delete archive
        del_req = urllib.request.Request(f"{self.base}/api/archives/{arch_id}", method="DELETE")
        with urllib.request.urlopen(del_req, timeout=5) as r:
            del_res = json.loads(r.read().decode("utf-8"))
            self.assertTrue(del_res["ok"])
            self.assertEqual(del_res["capabilities"]["loadedArchives"], 0)


if __name__ == "__main__":
    unittest.main()
