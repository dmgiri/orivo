"""Opt-in import instrumentation preserves actual ORM -> DTO projections."""
import base64
import hashlib
import importlib
import json
import sys
import tempfile
import unittest
import uuid
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "adapters" / "tracing"))
import studio_tracing as studio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Column, Integer, String, create_engine, select
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import StaticPool

Base = declarative_base()


class InventoryRecord(Base):
    __tablename__ = "projection_inventory"
    id = Column(Integer, primary_key=True)
    title = Column(String)
    unrelated = Column(String)
    price = Column(Integer)
    quantity = Column(Integer)


SOURCE = '''from pydantic import BaseModel, ConfigDict, Field, field_validator, field_serializer
events=[]
class Output(BaseModel):
    label:str=Field(serialization_alias='displayLabel')
    secondary:str=''
class Envelope(BaseModel):
    items:list[Output]
class NumericOutput(BaseModel):
    model_config=ConfigDict(frozen=True)
    total:int
class FloatOutput(BaseModel):
    model_config=ConfigDict(frozen=True)
    total:float
class MutableNumericOutput(BaseModel):
    total:int
class UnsafeOutput(BaseModel):
    label:str
    @field_validator('label')
    @classmethod
    def unchanged(cls,value):return value
class SerializedOutput(BaseModel):
    label:str
    @field_serializer('label')
    def changed(self,value):return value.upper()
def project(row):
    return Output(label=row.title,secondary=row.unrelated)
def calculated(row):
    return NumericOutput(total=row.price*row.quantity+99991)
def mutable_calculated(row):
    return MutableNumericOutput(total=row.price*row.quantity+99991)
def divided(row):
    return FloatOutput(total=row.price/row.quantity)
def arithmetic_order(row):
    return NumericOutput(total=observe('left',row).price*observe('right',row).quantity)
def unsupported_calculation(row):
    return NumericOutput(total=abs(row.price))
def repeated_string(row):
    return Output(label=row.title*2)
def dict_calculated(row):
    return {'total':row.price*row.quantity+99991,'label':row.title}
def dict_envelope(rows):
    return {'items':[dict_calculated(row) for row in rows]}
def dict_copied(row):
    captured=dict_calculated(row)
    return {'total':captured['total']}
def dict_order(row):
    return {'total':observe('left',row).price*observe('right',row).quantity,'total':row.price/row.quantity}
def dict_unsafe_keys(row):
    return {'__proto__':row.price,'total':row.price/row.quantity}
def envelope(rows):
    return Envelope(items=[project(row) for row in rows])
def transformed(row):
    return Output(label=row.title.upper())
def validator(row):
    return UnsafeOutput(label=row.title)
def serializer(row):
    return SerializedOutput(label=row.title)
def positional(value):
    return dict(value)
def observe(name,value):
    events.append(name)
    return value
def evaluation_order(row):
    return Output(label=observe('row',row).title,secondary=observe('secondary','fixed'))
def ordinary_function(**kwargs):
    return kwargs
def non_model(row):
    return ordinary_function(label=row.title)
class ClassMethod:
    @classmethod
    def project(cls,row):
        return Output(label=row.title)
class PrivateProjection:
    def __init__(self,row):
        self.__value=row.title
    def project(self):
        return Output(label=self.__value)
    def ordinary(self):
        return ordinary_function(label=self.__value)
    @classmethod
    def from_row(cls,row):
        instance=cls(row)
        return Output(label=instance.__value)
'''
ROUTE_SOURCE = '''from fastapi import FastAPI
from sqlalchemy import select
app=FastAPI()
@app.get('/inventory',response_model=ResponseModel)
def inventory():
    with Session() as session:
        rows=list(session.scalars(select(InventoryRecord).order_by(InventoryRecord.id)))
        return respond(rows)
'''


def decode(response):
    encoded = response.headers["Studio-Trace"]
    raw = base64.b64decode(encoded[3:] if encoded.startswith("z1.") else encoded)
    return json.loads(zlib.decompress(raw) if encoded.startswith("z1.") else raw)


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="anvaya-dto-projection-")
        self.root = Path(self.temporary.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith("anvaya-dto-projection-"))
        self.name = "anvaya_projection_fixture_" + uuid.uuid4().hex
        self.source_file = self.root / (self.name + ".py")
        self.source_file.write_text(SOURCE, encoding="utf-8")
        self.route_file = self.root / "inventory_api.py"
        self.route_file.write_text(ROUTE_SOURCE, encoding="utf-8")
        sys.path.insert(0, str(self.root))
        self.detach_projection = studio.instrument_project(self.root, include=["."])
        self.module = importlib.import_module(self.name)
        self.engine = create_engine("sqlite://", poolclass=StaticPool,
                                    connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(self.engine)
        with self.Session() as session:
            session.add_all([InventoryRecord(id=1, title="private-equal", unrelated="private-equal", price=10, quantity=2),
                             InventoryRecord(id=2, title="private-second", unrelated="private-second", price=20, quantity=3)])
            session.commit()
        self.detach = lambda: None
        self.scope = None

    def tearDown(self):
        self.detach()
        self.detach_projection()
        self.engine.dispose()
        sys.modules.pop(self.name, None)
        if str(self.root) in sys.path:
            sys.path.remove(str(self.root))
        # Each case owns a deleted temporary repository. Release its test-only
        # registration so this larger suite does not consume the production
        # process's fixed 16-root startup budget across unrelated cases.
        with studio._source_baseline_lock:
            studio._source_baselines.pop(self.root, None)
        self.temporary.cleanup()

    def configure(self, response_model, respond):
        root = self.root
        scope = {"__name__": self.name + "_api", "ResponseModel": response_model,
                 "Session": self.Session, "InventoryRecord": InventoryRecord, "respond": respond}
        exec(compile(ROUTE_SOURCE, str(self.route_file), "exec"), scope)
        self.detach = studio.setup(scope["app"], root, development=True,
                                   engine=self.engine, sessions=self.Session, response_models=True)
        self.scope = scope
        return TestClient(scope["app"])

    def request(self, client):
        return client.get("/inventory", headers={"X-Studio-Trace": "dto_projection_request_123"})

    def test_actual_constructor_arguments_survive_nested_prebuilt_envelopes(self):
        with self.configure(self.module.Envelope, self.module.envelope) as client:
            ordinary = client.get("/inventory")
            response = self.request(client)
            self.assertEqual(response.json(), ordinary.json())
            trace = decode(response)
            origin = trace["fields"]["items.1.displayLabel"]
            self.assertEqual(origin["table"], "projection_inventory")
            self.assertEqual(origin["column"], "title")
            self.assertEqual(trace["fields"]["items.1.secondary"]["column"], "unrelated")
            self.assertEqual(origin["projection"]["path"], self.source_file.name)
            self.assertEqual(origin["projection"]["hash"], hashlib.sha256(self.source_file.read_bytes()).hexdigest())
            self.assertNotIn("private-", json.dumps(trace))
            self.assertNotIn("fingerprint", json.dumps(trace))

    def test_computed_and_custom_model_paths_keep_values_without_column_claims(self):
        variants = [(self.module.Output, self.module.transformed),
                    (self.module.UnsafeOutput, self.module.validator),
                    (self.module.SerializedOutput, self.module.serializer)]
        for model, projection in variants:
            self.detach()
            with self.subTest(model=model.__name__, projection=projection.__name__):
                with self.configure(list[model], lambda rows: [projection(row) for row in rows]) as client:
                    response = self.request(client)
                    self.assertEqual(response.status_code, 200)
                    self.assertTrue(decode(response)["queries"])
                    self.assertEqual(decode(response)["fields"], {})

    def test_changed_dto_and_orm_values_do_not_keep_original_column(self):
        def mutated(rows):
            dto = self.module.project(rows[0])
            dto.label = "changed-dto"
            rows[1].title = "changed-orm"
            return [dto, self.module.project(rows[1])]
        with self.configure(list[self.module.Output], mutated) as client:
            response = self.request(client)
            self.assertEqual(response.json()[0]["displayLabel"], "changed-dto")
            fields = decode(response)["fields"]
            self.assertNotIn("0.displayLabel", fields)
            self.assertNotIn("1.displayLabel", fields)

    def test_source_edits_invalidate_new_projection_requests_with_old_loaded_code(self):
        with self.configure(list[self.module.Output], lambda rows: [self.module.project(row) for row in rows]) as client:
            self.assertIn("0.displayLabel", decode(self.request(client))["fields"])
            self.source_file.write_text(SOURCE + "\n# Edited after constructor code loaded.\n", encoding="utf-8")
            response = self.request(client)
            self.assertEqual(response.status_code, 200)
            trace = decode(response)
            self.assertIsNotNone(trace["route"])
            self.assertTrue(trace["queries"])
            self.assertEqual(trace["fields"], {})

    def test_evaluation_order_class_methods_and_non_model_calls_remain_ordinary(self):
        with self.configure(list[self.module.Output], lambda rows: [self.module.evaluation_order(rows[0]),
                                                                  self.module.ClassMethod.project(rows[1])]) as client:
            response = self.request(client)
            self.assertEqual(self.module.events, ["row", "secondary"])
            self.assertEqual(response.json()[0]["secondary"], "fixed")
            self.assertIn("0.displayLabel", decode(response)["fields"])
            self.assertIn("1.displayLabel", decode(response)["fields"])
        record = InventoryRecord(title="ordinary")
        self.assertEqual(self.module.non_model(record), {"label": "ordinary"})
        self.assertEqual(self.module.positional({"a": 1}), {"a": 1})

    def test_detach_disables_loaded_helpers_and_removes_import_finder(self):
        with self.configure(list[self.module.Output], lambda rows: [self.module.project(row) for row in rows]) as client:
            self.assertIn("0.displayLabel", decode(self.request(client))["fields"])
            self.detach_projection()
            self.detach_projection()
            self.assertEqual(decode(self.request(client))["fields"], {})

    def test_private_attributes_preserve_class_mangling_without_origin_claims(self):
        def private_outputs(rows):
            return [self.module.PrivateProjection(rows[0]).project(),
                    self.module.PrivateProjection.from_row(rows[1])]
        with self.configure(list[self.module.Output], private_outputs) as client:
            ordinary = client.get("/inventory")
            response = self.request(client)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), ordinary.json())
            self.assertEqual(response.json()[0]["displayLabel"], "private-equal")
            self.assertEqual(response.json()[1]["displayLabel"], "private-second")
            trace = decode(response)
            self.assertTrue(trace["queries"])
            self.assertEqual(trace["fields"], {})
        record = InventoryRecord(title="ordinary-private")
        self.assertEqual(self.module.PrivateProjection(record).ordinary(), {"label": "ordinary-private"})

    def test_measured_query_offsets_share_only_the_correlated_backend_request_clock(self):
        with self.configure(list[self.module.Output], lambda rows: [self.module.project(row) for row in rows]) as client:
            trace = decode(self.request(client))
            self.assertGreaterEqual(trace["durationMs"], 0)
            self.assertLess(trace["durationMs"], 86400000)
            for query in trace["queries"]:
                self.assertGreaterEqual(query["durationMs"], 0)
                self.assertGreaterEqual(query["startOffsetMs"], 0)
                self.assertLessEqual(query["startOffsetMs"] + query["durationMs"], trace["durationMs"])

    def test_numeric_operations_preserve_values_and_capture_every_loaded_input_without_literals(self):
        with self.configure(list[self.module.NumericOutput], lambda rows: [self.module.calculated(row) for row in rows]) as client:
            ordinary = client.get("/inventory")
            response = self.request(client)
            self.assertEqual(response.json(), ordinary.json())
            self.assertEqual(response.json()[0]["total"], 100011)
            trace = decode(response)
            origin = trace["fields"]["0.total"]
            self.assertEqual(origin["kind"], "computed")
            self.assertEqual(origin["operation"]["op"], "add")
            self.assertEqual(origin["operation"]["left"]["op"], "multiply")
            self.assertEqual(origin["operation"]["right"], {"kind": "constant"})
            self.assertEqual([item["column"] for item in origin["inputs"]], ["price", "quantity"])
            self.assertEqual(len(origin["queries"]), 1)
            self.assertEqual(origin["projection"]["hash"], hashlib.sha256(self.source_file.read_bytes()).hexdigest())
            self.assertNotIn('"value"', json.dumps(origin))
            self.assertNotIn('"result"', json.dumps(origin))

    def test_division_and_arithmetic_operands_evaluate_once_in_the_original_order(self):
        with self.configure(list[self.module.FloatOutput], lambda rows: [self.module.divided(row) for row in rows]) as client:
            response = self.request(client)
            self.assertEqual(response.json()[0]["total"], 5.0)
            self.assertEqual(decode(response)["fields"]["0.total"]["operation"]["op"], "divide")
        self.detach()
        with self.configure(list[self.module.NumericOutput], lambda rows: [self.module.arithmetic_order(rows[0])]) as client:
            response = self.request(client)
            self.assertEqual(self.module.events, ["left", "right"])
            self.assertEqual(response.json(), [{"total": 20}])
            self.assertIn("0.total", decode(response)["fields"])

    def test_unsupported_numeric_calls_string_operations_and_mutated_computed_dtos_keep_boundaries(self):
        variants = [(self.module.NumericOutput, self.module.unsupported_calculation),
                    (self.module.Output, self.module.repeated_string)]
        for model, projection in variants:
            self.detach()
            with self.configure(list[model], lambda rows: [projection(row) for row in rows]) as client:
                response = self.request(client)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(decode(response)["fields"], {})
        self.detach()
        def mutated(rows):
            value = self.module.mutable_calculated(rows[0])
            value.total += 1
            return [value]
        with self.configure(list[self.module.MutableNumericOutput], mutated) as client:
            self.assertEqual(decode(self.request(client))["fields"], {})

    def test_plain_dict_direct_fields_trace_but_calculations_remain_boundaries(self):
        with self.configure(None, self.module.dict_envelope) as client:
            ordinary = client.get('/inventory')
            response = self.request(client)
            self.assertEqual(response.json(), ordinary.json())
            fields = decode(response)['fields']
            self.assertEqual(set(fields), {'items.0.label', 'items.1.label'})
            self.assertTrue(all(origin['column'] == 'title' for origin in fields.values()))
        self.detach()
        with self.configure(None, lambda rows: [self.module.dict_copied(row) for row in rows]) as client:
            response = self.request(client)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(decode(response)['fields'], {})

    def test_dict_models_and_mutations_cannot_acquire_a_computed_origin(self):
        with self.configure(list[self.module.NumericOutput], lambda rows: [self.module.dict_calculated(row) for row in rows]) as client:
            self.assertEqual(decode(self.request(client))['fields'], {})
        self.detach()
        def changed(rows):
            result = self.module.dict_calculated(rows[0])
            result['total'] += 1
            return [result]
        with self.configure(None, changed) as client:
            fields = decode(self.request(client))['fields']
            self.assertNotIn('0.total', fields)
            self.assertEqual(fields['0.label']['column'], 'title')

    def test_dict_duplicate_keys_and_evaluation_order_keep_last_value_without_origin_claims(self):
        with self.configure(None, lambda rows: [self.module.dict_order(rows[0])]) as client:
            response = self.request(client)
            self.assertEqual(self.module.events, ['left', 'right'])
            self.assertEqual(response.json(), [{'total':5.0}])
            self.assertEqual(decode(response)['fields'], {})

    def test_same_value_reassignment_in_mutable_models_never_keeps_computed_provenance(self):
        def reassigned(rows):
            value = self.module.mutable_calculated(rows[0])
            value.total = 100011
            return [value]
        with self.configure(list[self.module.MutableNumericOutput], reassigned) as client:
            response = self.request(client)
            self.assertEqual(response.json(), [{'total':100011}])
            self.assertEqual(decode(response)['fields'], {})

    def test_orm_writes_and_flush_cannot_promote_literal_values_to_original_query_inputs(self):
        from sqlalchemy import inspect as orm_inspect
        for same_value in (False, True):
            self.detach()
            def changed(rows):
                row = rows[0]
                row.price = row.price if same_value else 11
                row.title = row.title if same_value else 'literal after read'
                orm_inspect(row).session.flush()
                return [self.module.calculated(row)]
            with self.subTest(same_value=same_value):
                with self.configure(list[self.module.NumericOutput], changed) as client:
                    response = self.request(client)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(decode(response)['fields'], {})
        self.detach()
        def restored(rows):
            row = rows[0]
            row.price = 11
            row.price = 10
            orm_inspect(row).session.flush()
            return [self.module.calculated(row)]
        with self.configure(list[self.module.NumericOutput], restored) as client:
            self.assertEqual(decode(self.request(client))['fields'], {})

    def test_direct_field_origins_also_reject_same_value_and_flushed_writes(self):
        from sqlalchemy import inspect as orm_inspect
        def changed(rows):
            row = rows[0]
            row.title = row.title
            orm_inspect(row).session.flush()
            return [self.module.project(row)]
        with self.configure(list[self.module.Output], changed) as client:
            fields = decode(self.request(client))['fields']
            self.assertNotIn('0.displayLabel', fields)
            self.assertIn('0.secondary', fields)


if __name__ == "__main__":
    unittest.main(verbosity=2)
