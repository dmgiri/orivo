"""Ordinary dictionary serializers retain executed ORM provenance without wrappers."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "adapters" / "tracing"))
import studio_tracing as studio
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

SOURCE = '''from sqlalchemy import Column, Integer, String, Date, DateTime, Uuid, Enum as SQLEnum, create_engine, select, func, text
from sqlalchemy.orm import declarative_base
from pydantic import BaseModel, field_validator
from datetime import date, datetime
from uuid import UUID
from enum import StrEnum
Base=declarative_base()
events=[]
class Status(StrEnum):
    ACTIVE='active'
class Output(BaseModel):
    name:str
    unrelated:str
class UnsafeOutput(Output):
    @field_validator('name')
    @classmethod
    def same(cls,value):return value
class DateOutput(BaseModel):
    public_id:UUID
    birthday:date
    created_at:datetime
    formatted:str
class StatusOutput(BaseModel):
    status:str
class Patient(Base):
    __tablename__='dictionary_patients'
    id=Column(Integer,primary_key=True)
    name=Column(String)
    unrelated=Column(String)
    public_id=Column(Uuid)
    birthday=Column(Date)
    created_at=Column(DateTime)
    status=Column(SQLEnum(Status))
    @property
    def display(self):
        events.append('property')
        return self.name
FIELDS=('id','name','unrelated')
def direct(row):
    return {'name':row.name,'unrelated':row.unrelated,'literal':'private-equal','computed':row.id+1}
def comprehension(row):
    return {key:getattr(row,key) for key in FIELDS}
def wide_comprehension(row):
    keys=['field_'+str(index) for index in range(2053)]
    return {key:row.name for key in keys}
def local_comprehension(row):
    fields=('name','unrelated')
    return {key:getattr(row,key) for key in locals()['fields']}
def nested(rows):
    return {'items':[{'patient':direct(row)} for row in rows]}
def aliases(row):
    result=comprehension(row)
    alias=result
    alias['name']='private-equal'
    return result
def update(row):
    result=direct(row)
    result.update(unrelated='private-equal',extra='constant')
    return result
def update_mapping(row):
    result=direct(row)
    result.update({'unrelated':'private-equal'})
    return result
def overwrite_same(row):
    result=direct(row)
    result['name']=result['name']
    return result
def remove_and_restore(row):
    result=direct(row)
    value=result.pop('name')
    result.setdefault('name',value)
    return result
def inplace(row):
    result=direct(row)
    result|={'name':'private-equal'}
    return result
def copy_dict(row):
    return dict(direct(row))
def copy_method(row):
    return direct(row).copy()
def spread(row):
    return {**direct(row)}
def external_mutation(row):
    result=direct(row)
    external(result)
    return result
def property_read(row):
    return {'name':row.display}
def observe(name,row):
    events.append(name)
    return row
def order(row):
    return {'name':observe('first',row).name,'name':observe('second',row).unrelated,'literal':'private-equal'}
def duplicate_literal(row):
    return {'name':row.name,'name':'private-equal'}
def unsafe_keys(row):
    return {'__proto__':row.name,'a.b':row.name,'constructor':row.name,'normal':row.name}
def literal(row):
    return {'name':'private-equal'}
def edited_during_capture(row):
    result=direct(row)
    edit_source()
    return result
def mutated_orm(row):
    row.name=row.name
    return direct(row)
def expanded(row):
    scalar=comprehension(row)
    return Output(**scalar)
def expanded_mutated(row):
    scalar=comprehension(row)
    scalar['name']=scalar['name']
    return Output(**scalar)
def expanded_unsafe(row):
    return UnsafeOutput(**comprehension(row))
def duplicate_expansion(row):
    events.append('start')
    try:
        return Output(**comprehension(row),**{'name':row.name},**later(row))
    except TypeError:
        events.append('duplicate')
        return {'name':'private-equal'}
def later(row):
    events.append('must not run')
    return {'unrelated':row.unrelated}
def temporal(row):
    return {'public_id':row.public_id,'birthday':row.birthday,'created_at':row.created_at,
            'formatted':row.created_at.isoformat(),'date_formatted':row.birthday.isoformat()}
def temporal_dto(row):
    return DateOutput(public_id=row.public_id,birthday=row.birthday,created_at=row.created_at,
                      formatted=row.created_at.isoformat())
def temporal_dict_mutated(row):
    result=temporal(row)
    result['public_id']=str(result['public_id'])
    result['formatted']=result['formatted']
    result['birthday']=result['birthday']
    return result
def temporal_dto_mutated(row):
    result=temporal_dto(row)
    result.public_id=str(result.public_id)
    result.formatted=result.formatted
    return result
def temporal_custom(value):
    return {'formatted':value.stamp.isoformat()}
def temporal_arguments(row):
    return {'formatted':row.created_at.isoformat(timespec='seconds')}
def status_dict(row):
    return {'status':row.status}
def status_dto(row):
    return StatusOutput(status=row.status)
def status_mutated(row):
    result=StatusOutput(status=row.status)
    result.status=result.status
    return result
def enum_source_mutated(row):
    row.status._value_=row.status._value_
    return {'status':row.status}
def after_many(session):
    for _ in range(35):
        session.scalar(select(func.count(Patient.id)))
    return [direct(row) for row in session.scalars(select(Patient).order_by(Patient.id))]
def after_large(session):
    from random import Random
    random=Random(123456)
    for _ in range(35):
        alias='fixture_'+''.join(random.choice('abcdefghijklmnopqrstuvwxyz') for _ in range(320))
        session.scalar(select(func.count(Patient.id).label(alias)))
    return [direct(row) for row in session.scalars(select(Patient).order_by(Patient.id))]
def failed(session):
    try:
        session.execute(text('SELECT missing FROM absent_fixture_table'))
    except Exception:
        return {'name':'private-equal'}
'''

ROUTE = '''from fastapi import FastAPI
from sqlalchemy import select
app=FastAPI()
@app.get('/patients',response_model=ResponseModel)
def patients():
    with Session() as session:
        if mode=='many':return project.after_many(session)
        if mode=='large':return project.after_large(session)
        if mode=='failed':return project.failed(session)
        if mode=='cached':return [project.direct(row) for row in cached]
        rows=list(session.scalars(select(project.Patient).order_by(project.Patient.id)))
        return respond(rows)
'''


def decode(response):
    encoded = response.headers["Studio-Trace"]
    raw = base64.b64decode(encoded[3:] if encoded.startswith("z1.") else encoded)
    value = json.loads(zlib.decompress(raw) if encoded.startswith("z1.") else raw)
    if value.get("encoding") != "anvaya-pool-v1":
        return value
    containers = []
    for kind, contents in value["pool"]:
        def resolve(item):
            return containers[item[0]] if type(item) is list else item
        containers.append({key: resolve(item) for key, item in contents.items()} if kind == 0
                          else [resolve(item) for item in contents])
    return containers[value["root"]]


class DictionaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="anvaya-dictionary-")
        self.root = Path(self.temporary.name).resolve()
        self.name = "anvaya_dictionary_fixture_" + uuid.uuid4().hex
        self.source = self.root / (self.name + ".py")
        self.source.write_text(SOURCE, encoding="utf-8")
        self.route_file = self.root / "api.py"
        self.route_file.write_text(ROUTE, encoding="utf-8")
        sys.path.insert(0, str(self.root))
        self.remove_imports = studio.instrument_project(self.root)
        self.module = importlib.import_module(self.name)
        self.engine = create_engine("sqlite://", poolclass=StaticPool,
                                    connect_args={"check_same_thread": False})
        self.module.Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(self.engine)
        with self.Session.begin() as session:
            from datetime import date, datetime
            session.add_all([self.module.Patient(id=1, name="private-equal", unrelated="private-equal",
                                                public_id=uuid.UUID(int=1), birthday=date(1990, 1, 1),
                                                created_at=datetime(2026, 1, 1, 12, 30, 45), status=self.module.Status.ACTIVE),
                             self.module.Patient(id=2, name="private-second", unrelated="private-second",
                                                public_id=uuid.UUID(int=2), birthday=date(1991, 1, 1),
                                                created_at=datetime(2026, 1, 2, 12, 30, 45), status=self.module.Status.ACTIVE)])
        self.detach = lambda: None
        self.cache_session = None

    def tearDown(self):
        self.detach()
        self.remove_imports()
        if self.cache_session:
            self.cache_session.close()
        self.engine.dispose()
        sys.modules.pop(self.name, None)
        sys.path.remove(str(self.root))
        with studio._source_baseline_lock:
            studio._source_baselines.pop(self.root, None)
        self.temporary.cleanup()

    def configure(self, respond=None, mode="normal", response_model=None, publish_trace=None):
        scope = {"__name__": self.name + "_api", "Session": self.Session, "project": self.module,
                 "respond": respond or (lambda rows: [self.module.direct(row) for row in rows]),
                 "mode": mode, "ResponseModel": response_model}
        if mode == "cached":
            from sqlalchemy import select
            self.cache_session = self.Session()
            scope["cached"] = list(self.cache_session.scalars(select(self.module.Patient)))
        exec(compile(ROUTE, str(self.route_file), "exec"), scope)
        self.detach = studio.setup(scope["app"], self.root, development=True, engine=self.engine,
                                   sessions=self.Session, response_models=True, publish_trace=publish_trace)
        return TestClient(scope["app"])

    def request(self, client, request_id="dictionary_trace_request_123"):
        return client.get("/patients", headers={"X-Studio-Trace": request_id})

    def assert_origin(self, trace, path, column="name"):
        origin = trace["fields"][path]
        self.assertEqual(origin["table"], "dictionary_patients")
        self.assertEqual(origin["column"], column)
        self.assertEqual(origin["model"], "Patient")
        self.assertEqual(origin["projection"]["hash"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(origin["modelSource"]["path"], self.source.name)
        query = next(query for query in trace["queries"] if query["id"] in origin["queries"])
        self.assertFalse(query["failed"])
        self.assertIn("dictionary_patients." + column, query["columns"])
        self.assertNotIn("private-", json.dumps(trace))
        self.assertNotIn("fingerprint", json.dumps(trace))

    def test_plain_dictionary_literals_are_exact_dict_and_do_not_guess_equal_values(self):
        with self.configure() as client:
            ordinary = client.get("/patients")
            response = self.request(client)
            self.assertEqual(response.json(), ordinary.json())
            trace = decode(response)
            self.assert_origin(trace, "0.name")
            self.assert_origin(trace, "1.unrelated", "unrelated")
            self.assertNotIn("0.literal", trace["fields"])
            self.assertNotIn("0.computed", trace["fields"])
        with self.Session() as session:
            self.assertIs(type(self.module.direct(session.get(self.module.Patient, 1))), dict)

    def test_getattr_comprehensions_and_nested_dictionary_lists(self):
        for factory in (lambda rows: [self.module.comprehension(row) for row in rows], self.module.nested):
            with self.configure(factory) as client:
                trace = decode(self.request(client))
                path = "items.1.patient.name" if factory is self.module.nested else "1.name"
                self.assert_origin(trace, path)
            self.detach()

    def test_wide_comprehension_runs_fully_while_capture_budget_is_bounded(self):
        published = []
        def publish(payload):
            published.append(payload)
            return 'a' * 32
        with self.configure(lambda rows: self.module.wide_comprehension(rows[0]), publish_trace=publish) as client:
            response = self.request(client)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.json()), 2053)
            self.assertEqual(response.json()['field_2052'], 'private-equal')
            self.assertEqual(len(published), 1)
            self.assertEqual(len(published[0]['fields']), 2048)
            self.assertTrue(published[0]['truncated'])

    def test_dictionary_keyword_expansion_preserves_provenance_into_safe_dto_only(self):
        with self.configure(lambda rows: [self.module.expanded(row) for row in rows],
                            response_model=list[self.module.Output]) as client:
            trace = decode(self.request(client))
            self.assert_origin(trace, "1.name")
            self.assert_origin(trace, "1.unrelated", "unrelated")
        self.detach()
        with self.configure(lambda rows: [self.module.expanded_mutated(row) for row in rows],
                            response_model=list[self.module.Output]) as client:
            trace = decode(self.request(client))
            self.assertNotIn("0.name", trace["fields"])
            self.assert_origin(trace, "0.unrelated", "unrelated")
        self.detach()
        with self.configure(lambda rows: [self.module.expanded_unsafe(row) for row in rows],
                            response_model=list[self.module.UnsafeOutput]) as client:
            self.assertEqual(decode(self.request(client))["fields"], {})

    def test_keyword_expansion_duplicate_error_keeps_python_evaluation_order(self):
        with self.configure(lambda rows: [self.module.duplicate_expansion(rows[0])]) as client:
            trace = decode(self.request(client))
            self.assertEqual(self.module.events, ["start", "duplicate"])
            self.assertEqual(trace["fields"], {})

    def test_frame_sensitive_comprehension_preserves_original_locals_without_claims(self):
        with self.configure(lambda rows: [self.module.local_comprehension(row) for row in rows]) as client:
            response = self.request(client)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()[0]["name"], "private-equal")
            self.assertEqual(decode(response)["fields"], {})

    def test_uninstrumented_bound_owner_closure_and_global_references_taint_same_value_writes(self):
        from types import SimpleNamespace
        values = {"name": "same"}
        class Owner:
            def __init__(self, payload):
                self.payload = payload
            def rewrite(self):
                self.payload["name"] = self.payload["name"]
        owner = Owner(values)
        def closure():
            values["name"] = values["name"]
        global _dictionary_taint_fixture
        _dictionary_taint_fixture = values
        def global_reference():
            _dictionary_taint_fixture["name"] = _dictionary_taint_fixture["name"]
        try:
            for function in (owner.rewrite, closure, global_reference):
                trace = studio.Trace(self.root, "external_boundary_123")
                origins = {"name": {"fingerprint": "not-published"}}
                trace.dictionary_origins[id(values)] = (values, origins)
                with studio.capture(trace):
                    studio._dictionary_callable(SimpleNamespace(active=True), function)()
                self.assertEqual(origins, {}, function)
        finally:
            del _dictionary_taint_fixture

    def test_optional_observer_failures_never_replace_or_repeat_application_calls(self):
        from types import SimpleNamespace
        events = []
        class Callable:
            @property
            def __class__(self):
                raise AssertionError("Capture must not invoke this getter")
            def __call__(self):
                events.append("called")
                return 42
        trace = studio.Trace(self.root, "observer_failure_123")
        self.assertIsNone(studio._dto_fingerprint(trace, Callable()))
        original = studio._external_function
        try:
            studio._external_function = lambda *args: (_ for _ in ()).throw(RuntimeError("optional observer"))
            with studio.capture(trace):
                self.assertEqual(studio._dictionary_callable(SimpleNamespace(active=True), Callable())(), 42)
            self.assertEqual(events, ["called"])
        finally:
            studio._external_function = original

    def test_exact_uuid_date_datetime_and_observed_isoformat_keep_actual_column(self):
        for factory, model in ((self.module.temporal, None), (self.module.temporal_dto, list[self.module.DateOutput])):
            with self.configure(lambda rows: [factory(row) for row in rows], response_model=model) as client:
                trace = decode(self.request(client))
                for name in ("public_id", "birthday", "created_at"):
                    self.assert_origin(trace, "1." + name, name)
                self.assert_origin(trace, "1.formatted", "created_at")
                self.assertEqual(trace["fields"]["1.formatted"]["transformation"], "isoformat")
                self.assertNotIn("transformation", trace["fields"]["1.created_at"])
            self.detach()

    def test_datetime_replacement_strings_and_same_value_dict_or_dto_writes_drop_claims(self):
        for factory, model in ((self.module.temporal_dict_mutated, None),
                               (self.module.temporal_dto_mutated, list[self.module.DateOutput])):
            with self.configure(lambda rows: [factory(row) for row in rows], response_model=model) as client:
                trace = decode(self.request(client))
                self.assertNotIn("0.public_id", trace["fields"])
                self.assertNotIn("0.formatted", trace["fields"])
                self.assert_origin(trace, "0.created_at", "created_at")
            self.detach()

    def test_custom_isoformat_getters_timezone_and_nondefault_arguments_do_not_claim_transformations(self):
        from datetime import datetime, timedelta, tzinfo
        events = []
        class CustomStamp(datetime):
            def isoformat(self):
                events.append("method")
                return "custom"
        class Value:
            @property
            def stamp(self):
                events.append("getter")
                return CustomStamp(2026, 1, 1)
        self.assertEqual(self.module.temporal_custom(Value()), {"formatted": "custom"})
        self.assertEqual(events, ["getter", "method"])
        class CustomTimezone(tzinfo):
            def utcoffset(self, value):
                events.append("timezone")
                return timedelta(0)
        value = datetime(2026, 1, 1, tzinfo=CustomTimezone())
        trace = studio.Trace(self.root, "custom_timezone_123")
        self.assertIsNone(studio._dto_fingerprint(trace, value))
        self.assertEqual(events, ["getter", "method"])
        with self.configure(lambda rows: [self.module.temporal_arguments(row) for row in rows]) as client:
            self.assertEqual(decode(self.request(client))["fields"], {})

    def test_canonical_serialization_matcher_keeps_type_tagged_fingerprints(self):
        from datetime import date, datetime, timezone
        trace = studio.Trace(self.root, "serialization_matcher_123")
        values = [uuid.UUID(int=1), date(2026, 1, 1), datetime(2026, 1, 1, tzinfo=timezone.utc)]
        encoded = [str(values[0]), "2026-01-01", "2026-01-01T00:00:00Z"]
        for value, output in zip(values, encoded):
            fingerprint = studio._dto_fingerprint(trace, value)
            self.assertTrue(studio._serialized_same(trace, value, output, fingerprint))
            self.assertNotEqual(fingerprint, studio._dto_fingerprint(trace, output))
            self.assertFalse(studio._serialized_same(trace, output, output, fingerprint))
            self.assertFalse(studio._serialized_same(trace, value, output + "changed", fingerprint))

    def test_normal_strenum_direct_or_pydantic_value_projection_keeps_actual_column(self):
        for factory, model in ((self.module.status_dict, None), (self.module.status_dto, list[self.module.StatusOutput])):
            with self.configure(lambda rows: [factory(row) for row in rows], response_model=model) as client:
                trace = decode(self.request(client))
                self.assert_origin(trace, "1.status", "status")
                if model is not None:
                    self.assertEqual(trace["fields"]["1.status"]["transformation"], "enum-value")
            self.detach()

    def test_strenum_same_value_writes_custom_value_or_repr_do_not_gain_proof(self):
        from enum import StrEnum
        for factory, model in ((self.module.enum_source_mutated, None),
                               (self.module.status_mutated, list[self.module.StatusOutput])):
            with self.configure(lambda rows: [factory(row) for row in rows], response_model=model) as client:
                self.assertEqual(decode(self.request(client))["fields"], {})
            self.detach()
        class CustomValue(StrEnum):
            ACTIVE = "active"
            @property
            def value(self):
                raise AssertionError("Custom enum value must never execute during capture")
        class CustomRepr(StrEnum):
            ACTIVE = "active"
            def __repr__(self):
                raise AssertionError("Custom enum repr must never execute during capture")
        trace = studio.Trace(self.root, "enum_guard_123")
        self.assertIsNone(studio._dto_fingerprint(trace, CustomValue.ACTIVE))
        self.assertIsNone(studio._dto_fingerprint(trace, CustomRepr.ACTIVE))
        fingerprint = studio._dto_fingerprint(trace, self.module.Status.ACTIVE)
        self.assertNotEqual(fingerprint, studio._dto_fingerprint(trace, "active"))

    def test_same_value_writes_aliases_removal_and_inplace_updates_drop_affected_origins(self):
        for name in ("aliases", "overwrite_same", "remove_and_restore", "inplace"):
            with self.configure(lambda rows: [getattr(self.module, name)(row) for row in rows]) as client:
                trace = decode(self.request(client))
                self.assertNotIn("0.name", trace["fields"], name)
                if name != "inplace":
                    self.assert_origin(trace, "0.unrelated", "unrelated")
            self.detach()

    def test_known_key_updates_preserve_unmodified_names_and_never_relabel_literals(self):
        for name in ("update", "update_mapping"):
            with self.configure(lambda rows: [getattr(self.module, name)(row) for row in rows]) as client:
                trace = decode(self.request(client))
                self.assert_origin(trace, "0.name")
                self.assertNotIn("0.unrelated", trace["fields"])
                self.assertNotIn("0.extra", trace["fields"])
            self.detach()

    def test_copies_spreads_and_external_same_value_mutation_do_not_inherit_container_proof(self):
        self.module.external = lambda value: value.__setitem__("name", value["name"])
        for name in ("copy_dict", "copy_method", "spread", "external_mutation", "literal"):
            with self.configure(lambda rows: [getattr(self.module, name)(row) for row in rows]) as client:
                self.assertEqual(decode(self.request(client))["fields"], {}, name)
            self.detach()

    def test_properties_duplicate_keys_and_evaluation_order_preserve_application_behavior(self):
        with self.configure(lambda rows: [self.module.property_read(rows[0])]) as client:
            trace = decode(self.request(client))
            self.assertEqual(self.module.events, ["property"])
            self.assertEqual(trace["fields"], {})
        self.detach()
        self.module.events.clear()
        with self.configure(lambda rows: [self.module.order(rows[0])]) as client:
            trace = decode(self.request(client))
            self.assertEqual(self.module.events, ["first", "second"])
            self.assert_origin(trace, "0.name", "unrelated")
        self.detach()
        with self.configure(lambda rows: [self.module.duplicate_literal(rows[0])]) as client:
            self.assertEqual(decode(self.request(client))["fields"], {})

    def test_unsafe_paths_mutated_orm_and_identity_map_cache_never_get_false_columns(self):
        with self.configure(lambda rows: [self.module.unsafe_keys(rows[0])]) as client:
            trace = decode(self.request(client))
            self.assertEqual(set(trace["fields"]), {"0.normal"})
        self.detach()
        with self.configure(lambda rows: [self.module.mutated_orm(rows[0])]) as client:
            trace = decode(self.request(client))
            self.assertNotIn("0.name", trace["fields"])
            self.assert_origin(trace, "0.unrelated", "unrelated")
        self.detach()
        with self.configure(mode="cached") as client:
            self.assertEqual(decode(self.request(client))["fields"], {})

    def test_more_than_twenty_queries_retain_actual_last_query_and_loaded_model(self):
        with self.configure(mode="many") as client:
            trace = decode(self.request(client))
            self.assertEqual(len(trace["queries"]), 36)
            self.assertFalse(trace["truncated"])
            self.assert_origin(trace, "1.name")
            self.assertEqual(trace["fields"]["1.name"]["queries"], [trace["queries"][-1]["id"]])

    def test_failed_query_and_changed_source_never_produce_field_proof(self):
        with self.configure(mode="failed") as client:
            trace = decode(self.request(client))
            self.assertTrue(trace["queries"][0]["failed"])
            self.assertEqual(trace["fields"], {})
        self.detach()
        with self.configure() as client:
            self.source.write_text(SOURCE + "\n# edited after import\n", encoding="utf-8")
            self.assertEqual(decode(self.request(client))["fields"], {})

    def test_source_paths_are_cached_per_request_and_revalidated_before_publication(self):
        from collections import Counter
        counts = Counter()
        original = studio._source_path
        def observed(root, filename):
            counts[str(filename)] += 1
            return original(root, filename)
        studio._source_path = observed
        try:
            trace = studio.Trace(self.root, "cached_sources_123")
            missing = str(self.root / "missing.py")
            for _ in range(200):
                self.assertIsNotNone(trace.site(str(self.source), 1, "fixture"))
                self.assertIsNone(trace.site(missing, 1, "missing"))
            self.assertEqual(counts[str(self.source)], 1)
            self.assertEqual(counts[missing], 1)
            trace.payload()
            self.assertEqual(counts[str(self.source)], 2)
        finally:
            studio._source_path = original

    def test_mid_request_source_edits_remove_cached_proof_at_publication(self):
        self.module.edit_source = lambda: self.source.write_text(SOURCE + "\n# changed during request\n", encoding="utf-8")
        with self.configure(lambda rows: [self.module.edited_during_capture(rows[0])]) as client:
            response = self.request(client)
            self.assertEqual(response.status_code, 200)
            trace = decode(response)
            self.assertEqual(trace["fields"], {})
            self.assertIsNone(trace["route"])
            self.assertTrue(trace["queries"])
            self.assertTrue(all(not query["site"] and not query["frames"] and "models" not in query
                                for query in trace["queries"]))

    def test_concurrent_requests_keep_dictionary_and_query_identity_isolated(self):
        with self.configure() as client:
            identifiers = ["dictionary_concurrent_" + str(index) for index in range(4)]
            with ThreadPoolExecutor(max_workers=4) as executor:
                traces = list(executor.map(lambda value: decode(self.request(client, value)), identifiers))
            query_ids = set()
            for identifier, trace in zip(identifiers, traces):
                self.assertEqual(trace["id"], identifier)
                self.assert_origin(trace, "1.name")
                current = {query["id"] for query in trace["queries"]}
                self.assertFalse(query_ids.intersection(current))
                query_ids.update(current)

    def test_managed_publisher_keeps_full_payload_and_small_correlated_reference(self):
        captured = []
        def publish(payload):
            captured.append(payload)
            return "a" * 32
        with self.configure(publish_trace=publish) as client:
            trace = decode(self.request(client))
            self.assert_origin(trace, "1.name")
            self.assertEqual(captured, [], "A complete fitting trace must not require another request")
        self.detach()
        with self.configure(mode="large", publish_trace=publish) as client:
            encode = studio._encode_trace_header
            try:
                studio._encode_trace_header = lambda payload: (_ for _ in ()).throw(
                    AssertionError("Managed large captures must bypass header pooling"))
                reference = decode(self.request(client))
            finally:
                studio._encode_trace_header = encode
            self.assertEqual(reference, {"id": "dictionary_trace_request_123", "ref": "anvaya-managed-v1", "key": "a" * 32})
            self.assert_origin(captured[0], "1.name")
            self.assertEqual(len(captured[0]["queries"]), 36)
            self.assertFalse(captured[0]["truncated"])
        self.detach()
        with self.configure(mode="large", publish_trace=lambda payload: "invalid") as client:
            response = self.request(client)
            trace = decode(response)
            self.assertTrue(trace["truncated"])
            self.assertTrue(trace["queries"])
            self.assertLessEqual(len(response.headers["Studio-Trace"]), 6144)
        self.detach()
        def unavailable(payload):
            raise RuntimeError("fixture store unavailable")
        with self.configure(mode="large", publish_trace=unavailable) as client:
            trace = decode(self.request(client))
            self.assertTrue(trace["truncated"])
            self.assertTrue(trace["queries"])


if __name__ == "__main__":
    unittest.main()
