"""Backend trace metadata must fit normal proxy response-header budgets."""
import base64
import hashlib
import importlib
import json
import secrets
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
import zlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "adapters" / "tracing"))
import studio_tracing as studio


def large_orm_payload():
    """A 20-row/200-origin trace with long, repeated application metadata.

    Repetitions exceed zlib's sliding window in the expanded trace. Interning
    containers keeps the exact statements, mapper classes and field origins.
    All per-query lists retain the ordinary adapter/DOM reader bounds.
    """
    def name(index):
        return "Catalog" + str(index) + "_" + ("MappedAttribute_" * 9)[:30]

    def site(index):
        filename = "backend/" + ("domain/subsystem/" + str(index) + "/") * 23 + "models.py"
        return {"path": filename, "line": 40 + index, "name": name(index),
                "hash": hashlib.sha256(str(index).encode()).hexdigest()}

    frames = [site(index) for index in range(12)]
    models = [{"model": name(index), "table": name(index), "modelSource": frames[index]}
              for index in range(12)]
    tables = [name(index) for index in range(20)]
    columns = [name(index % 12) + "." + name(index) for index in range(40)]
    sql = "SELECT " + ", ".join(columns) + " FROM " + tables[0]
    queries = [{"id": "query_" + str(index), "sql": sql, "tables": tables, "columns": columns,
                "frames": frames, "site": frames[-1], "models": models, "failed": False}
               for index in range(20)]
    fields = {f"items.{row}.field{column}": {
        "table": tables[0], "column": "field" + str(column), "model": models[0]["model"],
        "attribute": "field" + str(column), "queries": ["query_19"], "modelSource": frames[0],
        "fieldSource": {**frames[0], "line": 50 + column}, "projection": frames[1],
        "type": "String", "nullable": False
    } for row in range(20) for column in range(10)}
    return {"id": "large_orm_request_123", "route": site(99), "queries": queries,
            "fields": fields, "truncated": False}


def decode(encoded):
    packed = encoded.startswith("z1.")
    raw = base64.b64decode(encoded[3:] if packed else encoded)
    value = json.loads(zlib.decompress(raw) if packed else raw)
    if value.get("encoding") != "anvaya-pool-v1":
        return value
    pool = []
    for index, (kind, contents) in enumerate(value["pool"]):
        def child(item):
            if type(item) is list:
                if len(item) != 1 or type(item[0]) is not int or not 0 <= item[0] < index:
                    raise ValueError("Invalid compact reference")
                return pool[item[0]]
            return item
        pool.append({key: child(item) for key, item in contents.items()} if kind == 0
                    else [child(item) for item in contents])
    return pool[value["root"]]


class HeaderBoundsTests(unittest.TestCase):
    def trace(self):
        return studio.Trace(Path(__file__).parent, "proxy_header_request_123")

    def test_large_repeated_metadata_is_compressed_without_losing_origins(self):
        trace = self.trace()
        trace.route = {"path": "backend/api.py", "line": 42, "name": "catalog", "hash": "a" * 64}
        trace.queries = [{"id": "query_123", "sql": "SELECT title FROM catalog", "tables": ["catalog"],
                          "site": trace.route, "frames": [trace.route], "failed": False}]
        trace.fields = {f"items.{index}.label": {"table": "catalog", "column": "title", "model": "Catalog",
                         "queries": ["query_123"], "projection": trace.route} for index in range(150)}
        expected = dict(trace.fields)
        header = trace.header()
        self.assertTrue(header.startswith("z1."))
        self.assertLessEqual(len(header), 6144)
        payload = decode(header)
        self.assertEqual(payload["id"], "proxy_header_request_123")
        self.assertEqual(payload["fields"], expected)
        self.assertEqual(payload["queries"], trace.queries)
        self.assertFalse(payload["truncated"])

    def test_incompressible_metadata_falls_back_to_bounded_partial_trace(self):
        trace = self.trace()
        trace.queries = [{"id": str(index), "sql": secrets.token_hex(2000)} for index in range(20)]
        trace.fields = {"items.0.label": {"table": "catalog", "column": "title", "queries": ["0"]}}
        header = trace.header()
        self.assertLessEqual(len(header), 6144)
        payload = decode(header)
        self.assertTrue(payload["truncated"])
        self.assertEqual(payload["id"], "proxy_header_request_123")
        self.assertGreater(len(payload["queries"]), 0)
        self.assertLess(len(payload["queries"]), 20)
        ids = {query["id"] for query in payload["queries"]}
        self.assertIn("0", ids, "Prioritize the actual query referenced by the response field")
        self.assertEqual(payload["fields"], trace.fields)
        self.assertTrue(all(set(origin["queries"]).issubset(ids) for origin in payload["fields"].values()))

    def test_compact_pool_preserves_json_types_nested_arrays_and_unicode(self):
        site = {"path": "backend/models.py", "line": 42, "name": "Patient", "hash": "a" * 64}
        # Equal metadata with a different insertion order still interns once.
        payload = {"id": "unicode_request_123", "route": site,
                   "queries": [{"id": "query_123", "site": dict(reversed(list(site.items()))),
                                "frames": [site], "failed": False}],
                   "fields": {"items.0.label": {"modelSource": site, "nullable": False,
                              "label": "वर्ण — δοκιμή", "values": [None, True, False, 0, 1, 1.5, [], [1], [[0]]]}}}
        compact = studio._pooled_header_payload(payload)
        self.assertEqual(compact["root"], len(compact["pool"]) - 1)
        encoded = "z1." + base64.b64encode(zlib.compress(json.dumps(compact).encode())).decode()
        self.assertEqual(decode(encoded), payload)
        sites = [entry for entry in compact["pool"] if entry[0] == 0 and entry[1] == site]
        self.assertEqual(len(sites), 1)
        self.assertIs(decode(encoded)["fields"]["items.0.label"]["nullable"], False)

    def test_large_model_metadata_pool_preserves_every_query_and_200_field_origins(self):
        payload = large_orm_payload()
        raw = json.dumps(payload, separators=(",", ":")).encode()
        legacy = "z1." + base64.b64encode(zlib.compress(raw)).decode()
        self.assertGreater(len(legacy), 6144, "Exercise the former all-evidence-drop branch")
        self.assertLessEqual(len(raw), 1048576)
        header = studio._bounded_trace_header(payload)
        envelope = json.loads(zlib.decompress(base64.b64decode(header[3:])))
        self.assertEqual(envelope["encoding"], "anvaya-pool-v1")
        self.assertLessEqual(len(header), 6144)
        self.assertEqual(decode(header), payload)
        self.assertEqual(len(decode(header)["fields"]), 200)
        self.assertEqual(len(decode(header)["queries"]), 20)
        self.assertFalse(decode(header)["truncated"])

    def test_real_sqlalchemy_identifier_subclasses_use_lossless_pooling(self):
        from sqlalchemy.sql.elements import quoted_name

        payload = large_orm_payload()
        for query in payload["queries"]:
            query["tables"] = [quoted_name(table, quote=False) for table in query["tables"]]
            query["columns"] = [quoted_name(column, quote=True) for column in query["columns"]]
            for model in query["models"]:
                model["table"] = quoted_name(model["table"], quote=False)
        for origin in payload["fields"].values():
            origin["table"] = quoted_name(origin["table"], quote=False)
            origin["column"] = quoted_name(origin["column"], quote=True)
        expected = json.loads(json.dumps(payload))
        header = studio._bounded_trace_header(payload)
        envelope = json.loads(zlib.decompress(base64.b64decode(header[3:])))
        self.assertEqual(envelope["encoding"], "anvaya-pool-v1")
        self.assertLessEqual(len(header), 6144)
        self.assertEqual(decode(header), expected)
        self.assertFalse(decode(header)["truncated"])

    def test_oversized_512_origin_fallback_has_a_fixed_encoding_budget(self):
        payload = large_orm_payload()
        originals = list(payload["fields"].values())
        payload["fields"] = {f"items.{index}.label": originals[index % len(originals)]
                             for index in range(512)}
        self.assertGreater(len(json.dumps(payload, separators=(",", ":")).encode()), 1048576)
        encode = studio._encode_trace_header
        attempts = []

        def tracked(candidate):
            attempts.append(len(candidate["fields"]))
            return encode(candidate)

        with patch.object(studio, "_encode_trace_header", side_effect=tracked):
            header = studio._bounded_trace_header(payload)
        # One initial full-trace attempt, then at most ten origin-prefix
        # attempts including the final fit verification. Query trials have no
        # fields and are accounted separately by the bounded query cap.
        self.assertLessEqual(sum(count > 0 for count in attempts), 11)
        self.assertLessEqual(len(attempts), 35)
        result = decode(header)
        self.assertLessEqual(len(header), 6144)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["queries"], payload["queries"])
        self.assertGreater(len(result["fields"]), 0)
        self.assertLess(len(result["fields"]), 512)
        self.assertEqual(list(result["fields"]), list(payload["fields"])[:len(result["fields"])])
        self.assertEqual(result["fields"], {path: payload["fields"][path] for path in result["fields"]})
        ids = {query["id"] for query in result["queries"]}
        self.assertTrue(all(set(origin["queries"]).issubset(ids) for origin in result["fields"].values()))

    def test_twenty_row_page_keeps_last_description_direct_and_constructed_model_origins(self):
        from fastapi.testclient import TestClient
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool

        name = "response_page_" + uuid.uuid4().hex
        attributes = ["field" + str(index) for index in range(15)]
        columns = "\n".join("    " + field + " = Column(Integer)" for field in attributes)
        dto = "\n".join("    " + field + ": int" for field in attributes)
        arguments = ", ".join(field + "=row." + field for field in attributes)
        source = f'''from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Column, Integer, String, select
from sqlalchemy.orm import declarative_base
Base = declarative_base()
class Idea(Base):
    __tablename__ = "response_page_ideas"
    id = Column(Integer, primary_key=True)
{columns}
    body = Column(String)
class Output(BaseModel):
    model_config = ConfigDict(from_attributes=True)
{dto}
    body: str
class Page(BaseModel):
    items: list[Output]
app = FastAPI()
Session = None
@app.get("/ideas", response_model=Page)
def ideas():
    with Session() as session:
        rows = list(session.scalars(select(Idea)))
        return Page(items=[Output({arguments}, body=row.body) for row in rows])
@app.get("/direct", response_model=list[Output])
def direct():
    with Session() as session:
        return list(session.scalars(select(Idea)))
'''
        with tempfile.TemporaryDirectory(prefix="anvaya-response-page-") as temporary:
            root = Path(temporary).resolve()
            filename = root / (name + ".py")
            filename.write_text(source, encoding="utf-8")
            sys.path.insert(0, str(root))
            detach_imports = studio.instrument_project(root, include=["."])
            engine = None
            detach = None
            try:
                module = importlib.import_module(name)
                engine = create_engine("sqlite://", poolclass=StaticPool,
                                       connect_args={"check_same_thread": False})
                module.Base.metadata.create_all(engine)
                module.Session = sessionmaker(engine)
                with engine.begin() as connection:
                    connection.execute(module.Idea.__table__.insert(), [
                        {"id": row + 1, "body": "synthetic-description-" + str(row),
                         **{field: row + index for index, field in enumerate(attributes)}}
                        for row in range(20)
                    ])
                detach = studio.setup(module.app, root, development=True,
                                      engine=engine, sessions=module.Session, response_models=True)
                with TestClient(module.app) as client:
                    for endpoint, field in [("/ideas", "items.19.body"), ("/direct", "19.body")]:
                        ordinary = client.get(endpoint)
                        response = client.get(endpoint, headers={"X-Studio-Trace": "page_description_request_123"})
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.json(), ordinary.json())
                        self.assertLessEqual(len(response.headers["Studio-Trace"]), 6144)
                        trace = decode(response.headers["Studio-Trace"])
                        self.assertEqual(len(trace["queries"]), 1)
                        self.assertEqual(len(trace["fields"]), 320)
                        self.assertFalse(trace["truncated"])
                        origin = trace["fields"][field]
                        self.assertEqual(origin["queries"], [trace["queries"][0]["id"]])
                        self.assertEqual((origin["model"], origin["attribute"], origin["column"]),
                                         ("Idea", "body", "body"))
                        self.assertEqual(origin["modelSource"]["path"], filename.name)
                        self.assertEqual(origin["fieldSource"]["line"],
                                         source.splitlines().index("    body = Column(String)") + 1)
                        self.assertNotIn("synthetic-description-19", json.dumps(trace))
                        if endpoint == "/ideas":
                            self.assertEqual(origin["projection"]["path"], filename.name)
            finally:
                if detach is not None:
                    detach()
                detach_imports()
                if engine is not None:
                    engine.dispose()
                sys.modules.pop(name, None)
                sys.path.remove(str(root))
                with studio._source_baseline_lock:
                    studio._source_baselines.pop(root, None)

    def test_compact_pool_raises_for_cycles_and_excessive_depth(self):
        circular = {}
        circular["self"] = circular
        with self.assertRaises(ValueError):
            studio._pooled_header_payload(circular)
        nested = []
        for _ in range(20):
            nested = [nested]
        with self.assertRaises(ValueError):
            studio._pooled_header_payload({"nested": nested})

    def test_fallback_drops_origins_whose_nested_query_references_were_removed(self):
        trace = self.trace()
        trace.queries = [{"id": str(index), "sql": secrets.token_hex(2000)} for index in range(20)]
        trace.fields = {"items.0.total": {"kind": "computed", "queries": ["0"],
                          "operation": {"op": "add", "left": {"queries": ["missing"]},
                                        "right": {"kind": "constant"}}}}
        payload = decode(trace.header())
        self.assertTrue(payload["queries"])
        self.assertTrue(payload["truncated"])
        self.assertEqual(payload["fields"], {})

    def test_small_and_oversized_manual_trace_payloads_remain_decodable(self):
        small = self.trace().header()
        self.assertFalse(small.startswith("z1."))
        self.assertEqual(decode(small)["id"], "proxy_header_request_123")
        trace = self.trace()
        trace.route = {"path": secrets.token_hex(20000)}
        large = trace.header()
        self.assertLessEqual(len(large), 6144)
        self.assertIsNone(decode(large)["route"])
        self.assertTrue(decode(large)["truncated"])

    @unittest.skipUnless(shutil.which("node"), "Node is optional for standalone Python SDK checks")
    def test_large_trace_survives_default_node_http_proxy_without_body_change(self):
        trace = self.trace()
        trace.fields = {f"items.{index}.label": {"table": "catalog", "column": "title", "model": "Catalog",
                         "queries": ["query_123"]} for index in range(150)}
        header = trace.header()
        script = r'''
const http = require('node:http');
const assert = require('node:assert/strict');
(async () => {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const {header} = JSON.parse(input);
  const upstream = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Studio-Trace', header);
    response.end('{"ok":true}');
  });
  const proxy = http.createServer((request, response) => {
    // Deliberately use Node's ordinary header budget, with no maxHeaderSize.
    const forwarded = http.get('http://127.0.0.1:' + upstream.address().port, received => {
      response.writeHead(received.statusCode, received.headers);
      received.pipe(response);
    });
    forwarded.on('error', error => {
      response.statusCode = 502; response.end(error.code || error.message);
    });
  });
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const result = await fetch('http://127.0.0.1:' + proxy.address().port);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Studio-Trace'), header);
    assert.deepEqual(await result.json(), {ok:true});
    process.stdout.write('default proxy passed');
  } finally {
    await Promise.all([proxy, upstream].map(server => new Promise(resolve => {
      server.closeAllConnections(); server.close(resolve);
    })));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
'''
        result = subprocess.run([shutil.which("node"), "-e", script],
                                input=json.dumps({"header": header}), capture_output=True,
                                text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "default proxy passed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
