"""Collection counts are witnessed by actual native results and list structure."""
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

SOURCE = '''from sqlalchemy import Column,Integer,String,select,text
from sqlalchemy.orm import declarative_base
from pydantic import BaseModel,ConfigDict,field_validator,computed_field
from enum import Enum
Base=declarative_base()
events=[]
class Item(Base):
    __tablename__='collection_items'
    id=Column(Integer,primary_key=True)
    name=Column(String)
    @property
    def touch(self):
        self.name=self.name
        return 1
class View(BaseModel):
    model_config=ConfigDict(from_attributes=True)
    id:int
    name:str
class Page(BaseModel):
    items:list[View]
class Name(str,Enum):
    SYNTHETIC='Synthetic'
class ComputedView(View):
    @computed_field
    @property
    def caption(self)->str:return self.name.upper()
class EnumView(ComputedView):
    name:Name
class TouchView(View):
    touch:int
class UnsafePage(Page):
    @field_validator('items')
    @classmethod
    def replace(cls,value):return list(reversed(value))
def view(row):return View.model_validate(row,from_attributes=True)
def rows(session):
    return session.scalars(select(Item).order_by(Item.id)).all()
def direct(session):return rows(session)
def validated(session):return [ComputedView.model_validate(row) for row in rows(session)]
def validated_enum(session):return [EnumView.model_validate(row) for row in rows(session)]
def validated_mutation(session):return [TouchView.model_validate(row) for row in rows(session)]
def empty(session):
    session.execute(select(Item.id).where(Item.id==1)).all()
    return session.scalars(select(Item).where(Item.id<0)).all()
def page(session):
    original=rows(session)
    selected=original[:2]
    return Page(items=[view(row) for row in selected])
def empty_page(session):
    original=empty(session)
    selected=original[:2]
    return Page(items=[view(row) for row in selected])
def sliced(session):
    original=rows(session)
    return original[1::2]
def result_rows(session):
    original=session.execute(select(Item.id,Item.name).order_by(Item.id)).all()
    return [{'id':row.id,'name':row.name} for row in original]
def copied(session):return list(rows(session))
def filtered(session):
    original=rows(session)
    return [view(row) for row in original if row.id>1]
def reversed_rows(session):
    original=rows(session)
    original.reverse()
    return original
def same_value_write(session):
    original=rows(session)
    original[0]=original[0]
    return original
def mutated_mapping(session):
    original=rows(session)
    return [mutate(row,original) for row in original]
def mutate(row,original):
    if len(original)==3:original.pop()
    return view(row)
def unsafe_page(session):return UnsafePage(items=[view(row) for row in rows(session)])
def escaped(session):
    original=rows(session)
    external(original)
    return original
def cached(session):return saved
def repeated_all(session):
    result=session.scalars(select(Item).order_by(Item.id))
    first=result.all()
    second=result.all()
    return {'first':first,'second':second}
def edited(session):
    original=rows(session)
    edit_source()
    return original
def bounds(session):
    original=rows(session)
    return original[:custom_bound]
from sqlalchemy import ForeignKey
from sqlalchemy.orm import relationship,selectinload
class Detail(Base):
    __tablename__='collection_details'
    id=Column(Integer,primary_key=True)
    item_id=Column(Integer,ForeignKey('collection_items.id'))
    label=Column(String)
Item.detail=relationship(Detail,uselist=False)
class DetailView(BaseModel):
    model_config=ConfigDict(from_attributes=True)
    label:str
class NestedView(ComputedView):
    detail:DetailView
class UnsafeDetailView(DetailView):
    @field_validator('label')
    @classmethod
    def replace(cls,value):return value.upper()
class UnsafeNestedView(NestedView):
    detail:UnsafeDetailView
def nested(session):
    return [NestedView.model_validate(row) for row in session.scalars(select(Item).options(selectinload(Item.detail)).order_by(Item.id)).all()]
def unsafe_nested(session):
    return [UnsafeNestedView.model_validate(row) for row in session.scalars(select(Item).options(selectinload(Item.detail)).order_by(Item.id)).all()]
try:
    from sqlmodel import SQLModel,Field
    from sqlalchemy import MetaData
    class SQLItem(SQLModel,table=True):
        metadata=MetaData()
        __tablename__='sqlmodel_collection_items'
        id:int|None=Field(default=None,primary_key=True)
        name:str
        @property
        def touch(self):
            self.name=self.name
            return 1
    class SQLSimpleView(SQLModel):
        model_config=ConfigDict(from_attributes=True)
        name:str
        @computed_field
        @property
        def caption(self)->str:return self.name.upper()
    def sql_mapped(session):
        return [SQLSimpleView.model_validate(row) for row in session.scalars(select(SQLItem)).all()]
    class SQLTouchView(SQLSimpleView):
        touch:int
    def sql_mapped_mutation(session):
        return [SQLTouchView.model_validate(row) for row in session.scalars(select(SQLItem)).all()]
    class SQLDetailView(SQLModel):
        model_config=ConfigDict(from_attributes=True)
        label:str
    class SQLNestedView(SQLModel):
        model_config=ConfigDict(from_attributes=True)
        name:str
        detail:SQLDetailView
        @computed_field
        @property
        def caption(self)->str:return self.name.upper()
    def sql_nested(session):
        return [SQLNestedView.model_validate(row) for row in session.scalars(select(Item).options(selectinload(Item.detail)).order_by(Item.id)).all()]
    def sql_updated(session):
        return [SQLNestedView.model_validate(row,update={'name':'Override'}) for row in session.scalars(select(Item).options(selectinload(Item.detail)).order_by(Item.id)).all()]
except ImportError:
    SQLNestedView=None
'''

ROUTE = '''from fastapi import FastAPI
app=FastAPI()
@app.get('/items',response_model=ResponseModel)
def items():
    with Session() as session:return respond(session)
'''


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="anvaya-collections-")
        self.root = Path(self.temporary.name).resolve()
        self.name = "anvaya_collections_" + uuid.uuid4().hex
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
            session.add_all([self.project.Item(id=index, name="Synthetic") for index in range(1, 4)])
        self.detach = lambda: None
        self.cache_session = None

    def tearDown(self):
        self.detach()
        self.remove_imports()
        if self.cache_session:self.cache_session.close()
        self.engine.dispose()
        sys.modules.pop(self.name, None)
        sys.path.remove(str(self.root))
        with studio._source_baseline_lock:studio._source_baselines.pop(self.root, None)
        self.temporary.cleanup()

    def configure(self, mode="direct", model=None):
        scope = {"__name__": self.name + "_api", "Session": self.Session,
                 "respond": getattr(self.project, mode), "ResponseModel": model}
        exec(compile(ROUTE, str(self.route_file), "exec"), scope)
        self.detach = studio.setup(scope["app"], self.root, development=True, engine=self.engine,
                                   sessions=self.Session, response_models=True)
        return TestClient(scope["app"])

    def request(self, client):
        return client.get("/items", headers={"X-Studio-Trace": "collection_witness_trace_123"})

    def assert_collection(self, trace, path, count):
        value = trace["collections"][path]
        self.assertEqual(value["count"], count)
        self.assertEqual(value["source"]["path"], self.source.name)
        self.assertEqual(len(value["queries"]), 1)
        query = next(query for query in trace["queries"] if query["id"] == value["queries"][0])
        self.assertFalse(query["failed"])
        self.assertIn("collection_items", query["tables"])
        return query

    def test_actual_native_scalar_all_list_and_empty_list(self):
        for mode,count in (("direct",3),("empty",0)):
            with self.subTest(mode=mode), self.configure(mode, list[self.project.View]) as client:
                response = self.request(client)
                self.assertEqual(len(response.json()), count)
                trace=decode(response)
                query=self.assert_collection(trace,"",count)
                if mode=="empty":self.assertIs(query,trace["queries"][-1])
            self.detach()

    def test_observed_model_validate_retains_direct_fields_beside_computed_fields(self):
        with self.configure("validated", list[self.project.ComputedView]) as client:
            response = self.request(client)
            trace = decode(response)
            self.assertEqual(response.json()[0]["caption"], "SYNTHETIC")
            self.assertEqual(trace["fields"]["0.name"]["column"], "name")
            self.assertNotIn("0.caption", trace["fields"])

    def test_nested_loaded_relationships_retain_their_own_column_origins(self):
        with self.Session.begin() as session:
            session.add_all([self.project.Detail(id=i,item_id=i,label="Related") for i in range(1,4)])
        modes=[("nested",self.project.NestedView)]
        if self.project.SQLNestedView is not None:modes.append(("sql_nested",self.project.SQLNestedView))
        for mode,model in modes:
            with self.subTest(mode=mode),self.configure(mode,list[model]) as client:
                trace=decode(self.request(client))
                self.assertEqual(trace["fields"]["0.detail.label"]["table"],"collection_details")
                self.assertEqual(trace["fields"]["0.detail.label"]["column"],"label")
                self.assertNotIn("0.caption",trace["fields"])
            self.detach()

    def test_nested_custom_validation_and_sqlmodel_updates_do_not_claim_direct_origins(self):
        with self.Session.begin() as session:
            session.add_all([self.project.Detail(id=i,item_id=i,label="Related") for i in range(1,4)])
        modes=[("unsafe_nested",self.project.UnsafeNestedView)]
        if self.project.SQLNestedView is not None:modes.append(("sql_updated",self.project.SQLNestedView))
        for mode,model in modes:
            with self.subTest(mode=mode),self.configure(mode,list[model]) as client:
                trace=decode(self.request(client))
                self.assertNotIn("0.detail.label",trace["fields"])
                self.assertNotIn("0.name",trace["fields"])
            self.detach()

    def test_sqlmodel_mapped_instances_use_standard_loaded_attribute_access(self):
        if self.project.SQLNestedView is None:self.skipTest("SQLModel is not installed")
        self.project.SQLItem.__table__.create(self.engine)
        with self.Session.begin() as session:session.add(self.project.SQLItem(id=1,name="Mapped"))
        with self.configure("sql_mapped",list[self.project.SQLSimpleView]) as client:
            trace=decode(self.request(client))
            self.assertEqual(trace["fields"]["0.name"]["table"],"sqlmodel_collection_items")
            self.assertNotIn("0.caption",trace["fields"])

    def test_sqlmodel_same_value_writes_invalidate_the_origin(self):
        if self.project.SQLNestedView is None:self.skipTest("SQLModel is not installed")
        self.project.SQLItem.__table__.create(self.engine)
        with self.Session.begin() as session:session.add(self.project.SQLItem(id=1,name="Mapped"))
        with self.configure("sql_mapped_mutation",list[self.project.SQLTouchView]) as client:
            trace=decode(self.request(client))
            self.assertNotIn("0.name",trace["fields"])

    def test_standard_enum_validation_preserves_its_column(self):
        if not studio._safe_response_schema(self.project.EnumView.__pydantic_core_schema__, allow_computed=True):
            self.skipTest("This Pydantic version uses callback-based enum schemas")
        with self.configure("validated_enum", list[self.project.EnumView]) as client:
            trace = decode(self.request(client))
            self.assertEqual(trace["fields"]["0.name"]["transformation"], "enum-validation")

    def test_model_validate_cannot_retain_a_column_mutated_during_validation(self):
        with self.configure("validated_mutation", list[self.project.TouchView]) as client:
            trace = decode(self.request(client))
            self.assertNotIn("0.name", trace["fields"])
            self.assertNotIn("0.touch", trace["fields"])

    def test_actual_simple_slice_map_and_plain_pydantic_copy(self):
        for mode,count in (("page",2),("empty_page",0)):
            with self.subTest(mode=mode), self.configure(mode, self.project.Page) as client:
                response=self.request(client)
                self.assertEqual(len(response.json()["items"]),count)
                self.assert_collection(decode(response),"items",count)
            self.detach()

    def test_observed_native_result_all_and_slice_step(self):
        for mode,count in (("result_rows",3),("sliced",1)):
            with self.subTest(mode=mode),self.configure(mode) as client:
                self.assert_collection(decode(self.request(client)),"",count)
            self.detach()

    def test_mutations_copies_filters_unknown_escapes_and_custom_validation_do_not_claim(self):
        self.project.external=lambda value:None
        for mode in ("copied","filtered","reversed_rows","same_value_write","mutated_mapping","unsafe_page","escaped"):
            with self.subTest(mode=mode),self.configure(mode) as client:
                self.assertEqual(decode(self.request(client))["collections"],{})
            self.detach()

    def test_cached_list_and_repeated_consumption_do_not_acquire_new_query(self):
        self.cache_session=self.Session()
        self.project.saved=self.cache_session.scalars(select(self.project.Item)).all()
        with self.configure("cached") as client:self.assertEqual(decode(self.request(client))["collections"],{})
        self.detach()
        with self.configure("repeated_all") as client:
            trace=decode(self.request(client))
            self.assert_collection(trace,"first",3)
            self.assertNotIn("second",trace["collections"])

    def test_source_changed_after_capture_drops_membership_proof(self):
        self.project.edit_source=lambda:self.source.write_text(SOURCE+'\n# changed\n',encoding='utf-8')
        with self.configure("edited") as client:
            self.assertEqual(len(self.request(client).json()),3)
        self.detach()
        # Capture and edit in the same request with a fresh baseline.
        self.source.write_text(SOURCE,encoding='utf-8')
        with self.configure("edited") as client:self.assertEqual(decode(self.request(client))["collections"],{})

    def test_custom_slice_bound_runs_index_once_without_provenance(self):
        events=[]
        class Bound:
            def __index__(self):events.append('index');return 2
        self.project.custom_bound=Bound()
        with self.configure("bounds") as client:
            response=self.request(client)
            self.assertEqual(len(response.json()),2)
            self.assertEqual(events,['index'])
            self.assertEqual(decode(response)["collections"],{})

    def test_large_native_collection_keeps_full_response_but_bounds_witness_facts(self):
        with self.Session.begin() as session:
            session.add_all([self.project.Item(id=index,name='Synthetic') for index in range(4,2054)])
        with self.configure() as client:
            response=self.request(client)
            self.assertEqual(len(response.json()),2053)
            trace=decode(response)
            self.assertTrue(trace['truncated'])
            self.assertEqual(trace['collections'],{})


if __name__ == "__main__":unittest.main()
