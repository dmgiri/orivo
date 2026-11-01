"""Scalar SELECT provenance follows native Result/Row slots, never equal values."""
import importlib
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "adapters" / "tracing"))
import studio_tracing as studio
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from test_python_dictionary import decode

SOURCE = '''from sqlalchemy import Column, Integer, String, Uuid, select, func, literal, text
from sqlalchemy.orm import declarative_base
from sqlalchemy.types import TypeDecorator
from pydantic import BaseModel, field_validator
from uuid import UUID
Base=declarative_base()
events=[]
class Passthrough(TypeDecorator):
    impl=String
    cache_ok=True
    def process_result_value(self,value,dialect):
        events.append('processor')
        return value
class User(Base):
    __tablename__='row_users'
    id=Column(Uuid,primary_key=True)
    name=Column(String)
    duplicate=Column(String)
    custom=Column(Passthrough)
class Authors(BaseModel):
    authors:dict[UUID,str]
class UnsafeAuthors(Authors):
    @field_validator('authors')
    @classmethod
    def replace(cls,value):return {key:'equal' for key in value}
def direct(session):
    return {identifier:name or 'Member' for identifier,name in session.execute(select(User.id,User.name).order_by(User.id))}
def envelope(session):
    return Authors(authors=direct(session))
def unsafe_envelope(session):
    return UnsafeAuthors(authors=direct(session))
def duplicate_value(session):
    return {identifier:name or 'Member' for identifier,name in session.execute(select(User.id,User.duplicate).order_by(User.id))}
def computed(session):
    return {identifier:name or 'Member' for identifier,name in session.execute(select(User.id,func.upper(User.name)).order_by(User.id))}
def custom(session):
    return {identifier:name or 'Member' for identifier,name in session.execute(select(User.id,User.custom).order_by(User.id))}
def duplicate_column(session):
    return {identifier:name or 'Member' for identifier,name,again in session.execute(select(User.id,User.name,User.name).order_by(User.id))}
def core(session):
    return {identifier:name or 'Member' for identifier,name in session.execute(select(User.__table__.c.id,User.__table__.c.name).order_by(User.id))}
def fake(session):
    return {identifier:name or 'Member' for identifier,name in [(UUID(int=1),'equal'),(UUID(int=2),'equal')]}
def expanded(session):
    return {**direct(session)}
def overwritten(session):
    result=direct(session)
    result[UUID(int=1)]='equal'
    return result
def interleaved(session):
    first=session.execute(select(User.id,User.name).order_by(User.id))
    second=session.execute(select(User.id,User.duplicate).order_by(User.id))
    return {'first':{identifier:name or 'Member' for identifier,name in first},
            'second':{identifier:name or 'Member' for identifier,name in second}}
def escaped(session):
    result=session.execute(select(User.id,User.name).order_by(User.id))
    external(result)
    return {identifier:name or 'Member' for identifier,name in result}
def columns_mutated(session):
    result=session.execute(select(User.id,User.name).order_by(User.id))
    result.columns('id','name')
    return {identifier:name or 'Member' for identifier,name in result}
def cached(session):
    return {identifier:name or 'Member' for identifier,name in saved_result}
def failed(session):
    try:session.execute(text('select * from missing_row_table'))
    except Exception:pass
    return fake(session)
def identity(session):
    result=session.execute(select(User.id,User.name).order_by(User.id))
    return inspect_identity(result)
def short_circuit(session):
    return {identifier:name or 'Member' or 'never' for identifier,name in session.execute(select(User.id,User.name).order_by(User.id))}
'''

ROUTE = '''from fastapi import FastAPI
app=FastAPI()
@app.get('/authors',response_model=ResponseModel)
def authors():
    with Session() as session:
        return respond(session)
'''


class RowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="anvaya-rows-")
        self.root = Path(self.temporary.name).resolve()
        self.name = "anvaya_rows_" + uuid.uuid4().hex
        self.source = self.root / (self.name + ".py")
        self.source.write_text(SOURCE, encoding="utf-8")
        self.route_file = self.root / "api.py"
        self.route_file.write_text(ROUTE, encoding="utf-8")
        sys.path.insert(0, str(self.root))
        self.remove_imports = studio.instrument_project(self.root)
        self.project = importlib.import_module(self.name)
        self.engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
        self.project.Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(self.engine)
        with self.Session.begin() as session:
            session.add_all([self.project.User(id=uuid.UUID(int=1), name="equal", duplicate="equal", custom="equal"),
                             self.project.User(id=uuid.UUID(int=2), name=None, duplicate="equal", custom="equal")])
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

    def configure(self, mode="direct", model=None):
        scope = {"__name__": self.name + "_api", "Session": self.Session,
                 "respond": getattr(self.project, mode), "ResponseModel": model}
        exec(compile(ROUTE, str(self.route_file), "exec"), scope)
        self.detach = studio.setup(scope["app"], self.root, development=True, engine=self.engine,
                                   sessions=self.Session, response_models=True)
        return TestClient(scope["app"])

    def request(self, client):
        return client.get("/authors", headers={"X-Studio-Trace": "row_projection_trace_123456"})

    def assert_origin(self, trace, path, column="name"):
        origin = trace["fields"][path]
        self.assertEqual((origin["table"], origin["column"], origin["model"]), ("row_users", column, "User"))
        self.assertEqual(origin["modelSource"]["path"], self.source.name)
        self.assertEqual(origin["fieldSource"]["path"], self.source.name)
        self.assertEqual(origin["projection"]["path"], self.source.name)
        queries = [query for query in trace["queries"] if query["id"] in origin["queries"]]
        self.assertEqual(len(queries), 1)
        self.assertIn("row_users." + column, queries[0]["columns"])
        self.assertFalse(queries[0]["failed"])
        self.assertNotIn("equal", str(trace))
        return queries[0]["id"]

    def test_direct_tuple_unpack_and_actual_or_branch(self):
        with self.configure() as client:
            response = self.request(client)
            self.assertEqual(response.json(), {str(uuid.UUID(int=1)): "equal", str(uuid.UUID(int=2)): "Member"})
            trace = decode(response)
            self.assert_origin(trace, str(uuid.UUID(int=1)))
            self.assertNotIn(str(uuid.UUID(int=2)), trace["fields"])

    def test_standard_dto_uuid_key_dictionary_copy_retains_structural_origins(self):
        with self.configure("envelope", self.project.Authors) as client:
            response = self.request(client)
            self.assertEqual(response.json()["authors"][str(uuid.UUID(int=1))], "equal")
            self.assert_origin(decode(response), "authors." + str(uuid.UUID(int=1)))

    def test_same_values_follow_selected_slot_instead_of_name_or_value(self):
        with self.configure("duplicate_value") as client:
            trace = decode(self.request(client))
            self.assert_origin(trace, str(uuid.UUID(int=1)), "duplicate")
            self.assert_origin(trace, str(uuid.UUID(int=2)), "duplicate")

    def test_interleaved_results_keep_their_actual_execution_tokens(self):
        with self.configure("interleaved") as client:
            trace = decode(self.request(client))
            first = self.assert_origin(trace, "first." + str(uuid.UUID(int=1)))
            second = self.assert_origin(trace, "second." + str(uuid.UUID(int=1)), "duplicate")
            self.assertNotEqual(first, second)

    def test_computed_sql_core_custom_processors_and_ambiguous_slots_do_not_claim_origin(self):
        for mode in ("computed", "core", "custom", "duplicate_column", "fake", "failed"):
            with self.subTest(mode=mode), self.configure(mode) as client:
                response = self.request(client)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(decode(response)["fields"], {})
            self.detach()
        self.assertEqual(self.project.events, ["processor", "processor"])

    def test_copy_mutation_and_unsafe_validation_discard_optional_claims(self):
        for mode, model in (("expanded", None), ("overwritten", None), ("unsafe_envelope", self.project.UnsafeAuthors)):
            with self.subTest(mode=mode), self.configure(mode, model) as client:
                trace = decode(self.request(client))
                self.assertEqual(trace["fields"], {})
            self.detach()

    def test_unknown_result_escapes_and_result_metadata_mutations_are_rejected(self):
        self.project.external = lambda result: None
        for mode in ("escaped", "columns_mutated"):
            with self.subTest(mode=mode), self.configure(mode) as client:
                self.assertEqual(decode(self.request(client))["fields"], {})
            self.detach()

    def test_cached_result_from_outside_request_is_not_reused(self):
        self.cache_session = self.Session()
        self.project.saved_result = self.cache_session.execute(select(self.project.User.id, self.project.User.name))
        with self.configure("cached") as client:
            self.assertEqual(decode(self.request(client))["fields"], {})

    def test_native_result_row_and_scalar_objects_are_not_wrapped(self):
        from sqlalchemy.engine import Row
        seen = []
        def inspect_identity(result):
            native = result
            row = next(iter(result))
            seen.append((native is result, type(row) is Row, tuple(row)[0] is row._data[0], tuple(row)[1] is row._data[1]))
            return {"native": all(seen[-1])}
        self.project.inspect_identity = inspect_identity
        with self.configure("identity") as client:
            self.assertEqual(self.request(client).json(), {"native": True})
        self.assertEqual(seen, [(True, True, True, True)])

    def test_or_chain_keeps_native_short_circuit_and_literal_fallback(self):
        with self.configure("short_circuit") as client:
            response = self.request(client)
            self.assertEqual(response.json()[str(uuid.UUID(int=2))], "Member")
            self.assert_origin(decode(response), str(uuid.UUID(int=1)))
            self.assertNotIn(str(uuid.UUID(int=2)), decode(response)["fields"])


if __name__ == "__main__":
    unittest.main()
