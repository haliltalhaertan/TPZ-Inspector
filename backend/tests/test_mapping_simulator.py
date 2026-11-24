#!/usr/bin/env python3
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from mapping_simulator import (  # noqa: E402
    RESULT_CC,
    RESULT_SUPPRESS,
    RESULT_XSI_NIL,
    simulate_mapping,
)


class TestMappingSimulator(unittest.TestCase):
    def test_standard_functions_and_real_java_udf_value_and_context(self):
        mapping_payload = {
            "fieldMappings": [
                {"targetPath": "/MT_OrderTarget/Header/OrderId", "expression": "/MT_OrderSource/Head/DocNumber"},
                {"targetPath": "/MT_OrderTarget/Header/TaxId", "expression": "formatTaxNumber(/MT_OrderSource/Head/CustomerTax, 'TR')"},
                {"targetPath": "/MT_OrderTarget/Header/Filtered", "expression": "deleteSuppress(/MT_OrderSource/Line/Note)"},
                {"targetPath": "/MT_OrderTarget/Items/Item/Material", "expression": "useOneAsMany(...)"},
                {"targetPath": "/MT_OrderTarget/Items/Item/Quantity", "expression": "concat(/MT_OrderSource/Line/Qty, /MT_OrderSource/Line/Uom)"},
            ],
            "udfs": [
                {
                    "key": "udf_tax",
                    "name": "formatTaxNumber",
                    "cacheType": "value",
                    "arguments": [
                        {"name": "rawTax", "javaType": "String"},
                        {"name": "country", "javaType": "String"},
                    ],
                    "javaCode": (
                        'container.getTrace().addInfo("Cleaning tax: " + rawTax);\n'
                        'if (rawTax == null || rawTax.trim().isEmpty()) return ResultList.SUPPRESS;\n'
                        'return "TR-" + country + "-" + rawTax.replaceAll("[^0-9]", "");'
                    ),
                },
                {
                    "key": "udf_del_sup",
                    "name": "deleteSuppress",
                    "cacheType": "context",
                    "arguments": [{"name": "vals", "javaType": "String"}],
                    "javaCode": (
                        'for (int i = 0; i < vals.length; i++) {\n'
                        '  if (!ResultList.SUPPRESS.equals(vals[i]) && !vals[i].isEmpty()) {\n'
                        '    result.addValue(vals[i].toUpperCase());\n'
                        '  } else {\n'
                        '    result.addSuppress();\n'
                        '  }\n'
                        '}\n'
                    ),
                },
            ],
            "graphNodes": [
                # Target 1: direct
                {"id": "t1", "kind": "target", "label": "OrderId", "path": "/MT_OrderTarget/Header/OrderId", "targetGroup": "/MT_OrderTarget/Header/OrderId"},
                {"id": "s1", "kind": "source", "label": "DocNumber", "path": "/MT_OrderSource/Head/DocNumber", "targetGroup": "/MT_OrderTarget/Header/OrderId"},
                # Target 2: value UDF
                {"id": "t2", "kind": "target", "label": "TaxId", "path": "/MT_OrderTarget/Header/TaxId", "targetGroup": "/MT_OrderTarget/Header/TaxId"},
                {"id": "u2", "kind": "udf", "label": "formatTaxNumber", "udfKey": "udf_tax", "targetGroup": "/MT_OrderTarget/Header/TaxId"},
                {"id": "s2", "kind": "source", "label": "CustomerTax", "path": "/MT_OrderSource/Head/CustomerTax", "targetGroup": "/MT_OrderTarget/Header/TaxId"},
                {"id": "c2", "kind": "const", "label": "'TR'", "value": "TR", "targetGroup": "/MT_OrderTarget/Header/TaxId"},
                # Target 3: context ResultList UDF (tests ResultList.SUPPRESS = "_sUpPresSeD_")
                {"id": "t3", "kind": "target", "label": "Filtered", "path": "/MT_OrderTarget/Header/Filtered", "targetGroup": "/MT_OrderTarget/Header/Filtered"},
                {"id": "u3", "kind": "udf", "label": "deleteSuppress", "udfKey": "udf_del_sup", "targetGroup": "/MT_OrderTarget/Header/Filtered"},
                {"id": "s3", "kind": "source", "label": "Note", "path": "/MT_OrderSource/Line/Note", "targetGroup": "/MT_OrderTarget/Header/Filtered"},
                # Target 4: concat with delimiter
                {"id": "t4", "kind": "target", "label": "Quantity", "path": "/MT_OrderTarget/Items/Item/Quantity", "targetGroup": "/MT_OrderTarget/Items/Item/Quantity"},
                {"id": "f4", "kind": "func", "label": "concat", "function": "concat", "parameters": {"delimeter": " "}, "targetGroup": "/MT_OrderTarget/Items/Item/Quantity"},
                {"id": "s4a", "kind": "source", "label": "Qty", "path": "/MT_OrderSource/Line/Qty", "targetGroup": "/MT_OrderTarget/Items/Item/Quantity"},
                {"id": "s4b", "kind": "source", "label": "Uom", "path": "/MT_OrderSource/Line/Uom", "targetGroup": "/MT_OrderTarget/Items/Item/Quantity"},
            ],
            "graphEdges": [
                {"id": "e1", "source": "s1", "target": "t1", "label": "in[0]"},
                {"id": "e2", "source": "u2", "target": "t2", "label": "in[0]"},
                {"id": "e2a", "source": "s2", "target": "u2", "label": "arg[0]"},
                {"id": "e2b", "source": "c2", "target": "u2", "label": "arg[1]"},
                {"id": "e3", "source": "u3", "target": "t3", "label": "in[0]"},
                {"id": "e3a", "source": "s3", "target": "u3", "label": "arg[0]"},
                {"id": "e4", "source": "f4", "target": "t4", "label": "in[0]"},
                {"id": "e4a", "source": "s4a", "target": "f4", "label": "arg[0]"},
                {"id": "e4b", "source": "s4b", "target": "f4", "label": "arg[1]"},
            ],
        }

        source_xml = """<?xml version="1.0" encoding="UTF-8"?>
<MT_OrderSource>
  <Head>
    <DocNumber>ORD-2026-99</DocNumber>
    <CustomerTax>123-456-7890</CustomerTax>
  </Head>
  <Line>
    <Qty>10</Qty>
    <Uom>EA</Uom>
    <Note>urgent</Note>
  </Line>
  <Line>
    <Qty>25</Qty>
    <Uom>KG</Uom>
    <Note></Note>
  </Line>
</MT_OrderSource>"""

        res = simulate_mapping(mapping_payload, source_xml, execute_java_udfs=True)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["engine"], "local-java-udf")

        by_path = {q["targetPath"]: q for q in res["targetQueues"]}
        self.assertEqual(by_path["/MT_OrderTarget/Header/OrderId"]["queue"], ["ORD-2026-99"])
        self.assertEqual(by_path["/MT_OrderTarget/Header/TaxId"]["queue"], ["TR-TR-1234567890"])
        self.assertEqual(by_path["/MT_OrderTarget/Header/Filtered"]["queue"], ["URGENT", RESULT_CC, RESULT_SUPPRESS])
        self.assertEqual(by_path["/MT_OrderTarget/Items/Item/Quantity"]["queue"], ["10 EA", RESULT_CC, "25 KG"])

        # Trace captured from container.getTrace().addInfo()
        self.assertTrue(any("Cleaning tax: 123-456-7890" in t["message"] for t in res["traces"]))

        # Target XML properly formatted and contains both repeating Item rows & filtered output
        self.assertIn("<OrderId>ORD-2026-99</OrderId>", res["targetXml"])
        self.assertIn("<TaxId>TR-TR-1234567890</TaxId>", res["targetXml"])
        self.assertIn("<Quantity>10 EA</Quantity>", res["targetXml"])
        self.assertIn("<Quantity>25 KG</Quantity>", res["targetXml"])
        self.assertIn("<Filtered>URGENT</Filtered>", res["targetXml"])
        self.assertNotIn(RESULT_SUPPRESS, res["targetXml"])
        self.assertNotIn(RESULT_XSI_NIL, res["targetXml"])


if __name__ == "__main__":
    unittest.main()
