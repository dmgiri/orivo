"""Runtime SQLAlchemy model declarations are optional, hash-checked evidence."""
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
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect as orm_inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


MIXINS = '''from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column
class LabelMixin:
    label: Mapped[str] = mapped_column("display_label", String, nullable=False)
'''

MODELS = '''from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from {name}_mixins import LabelMixin
class Base(DeclarativeBase):
    pass
class Item(LabelMixin, Base):
    __tablename__ = "model_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    price: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity = Column(Integer, nullable=True)
class OtherItem(Base):
    __tablename__ = "other_model_items"
    id: Mapped[int] = mapped_column(primary_key=True)
ItemAlias = Item
Item.runtime = Column(Integer)
class ItemDTO(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    title: str = Field(validation_alias="label", serialization_alias="displayTitle")
    price: int
class NumericDTO(BaseModel):
    model_config = ConfigDict(frozen=True)
    total: int
class FirstNamespace:
    class Twin:
        first = 1
class SecondNamespace:
    class Twin:
        second = 1
class Repeated:
    field = 1
FirstRepeated = Repeated
class Repeated:
    field = 2
'''

API = '''from fastapi import FastAPI
from sqlalchemy import select
from {name}_models import ItemAlias, ItemDTO, NumericDTO, OtherItem
import {name}_models as model_module
app = FastAPI()
Session = None
@app.get("/items", response_model=list[ItemDTO])
def items(mutate: bool = False):
    with Session() as session:
        rows = list(session.scalars(select(ItemAlias)))
        if mutate:
            rows[0].price = rows[0].price
            session.flush()
        return rows
@app.get("/computed", response_model=list[NumericDTO])
def computed():
    with Session() as session:
        rows = list(session.scalars(select(ItemAlias)))
        return [NumericDTO(total=row.price * row.quantity) for row in rows]
@app.get("/dict-items")
def dict_items():
    with Session() as session:
        rows = list(session.scalars(select(ItemAlias)))
        return [{{"price": row.price, "title": row.label}} for row in rows]
@app.get("/interleaved")
def interleaved():
    with Session() as session:
        first = session.scalars(select(ItemAlias))
        second = session.scalars(select(OtherItem))
        others = list(second)
        items = list(first)
        return {{"items": len(items), "others": len(others)}}
@app.get("/interleaved-fields", response_model=list[ItemDTO])
def interleaved_fields():
    with Session() as session:
        first = session.scalars(select(ItemAlias).where(ItemAlias.id == 1))
        second = session.scalars(select(ItemAlias).where(ItemAlias.id == 2))
        later_rows = list(second)
        return list(first)
@app.get("/reused")
def reused():
    with Session() as session:
        first = list(session.scalars(select(ItemAlias)))
        second = list(session.scalars(select(ItemAlias)))
        return {{"same": first[0] is second[0]}}
@app.get("/columns")
def columns():
    with Session() as session:
        return list(session.scalars(select(ItemAlias.price)))
@app.get("/core-columns")
def core_columns():
    with Session() as session:
        return list(session.scalars(select(ItemAlias.__table__.c.price)))
@app.get("/failed-columns")
def failed_columns():
    from sqlalchemy import text
    with Session() as session:
        try:
            return list(session.scalars(select(ItemAlias.price).where(text('missing_fixture_column = 1'))))
        except Exception:
            return []
@app.get("/many-models")
def many_models():
    with Session() as session:
        models = model_module.ExtraModels
        statement = select(*models)
        for model in models[1:]:
            statement = statement.join_from(models[0], model, models[0].id == model.id)
        rows = session.execute(statement).all()
        return {{"rows": len(rows)}}
'''


def decode(response):
    encoded = response.headers["Studio-Trace"]
    raw = base64.b64decode(encoded[3:] if encoded.startswith("z1.") else encoded)
    return json.loads(zlib.decompress(raw) if encoded.startswith("z1.") else raw)


def model_variant(transform):
    def decorate(test):
        test.model_transform = transform
        return test
    return decorate


class ModelEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="anvaya-model-evidence-")
        self.root = Path(self.temporary.name).resolve()
        self.name = "model_fixture_" + uuid.uuid4().hex
        model_source = MODELS.format(name=self.name)
        transform = getattr(getattr(self, self._testMethodName), "model_transform", None)
        if transform is not None:
            model_source = transform(model_source)
        self.sources = {"mixins": MIXINS, "models": model_source,
                        "api": API.format(name=self.name)}
        self.files = {}
        for suffix, source in self.sources.items():
            filename = self.root / f"{self.name}_{suffix}.py"
            filename.write_text(source, encoding="utf-8")
            self.files[suffix] = filename
        sys.path.insert(0, str(self.root))
        self.detach_imports = studio.instrument_project(self.root, include=["."])
        self.models = importlib.import_module(self.name + "_models")
        self.api = importlib.import_module(self.name + "_api")
        self.engine = create_engine("sqlite://", poolclass=StaticPool,
                                    connect_args={"check_same_thread": False})
        self.models.Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(self.engine)
        label_column = orm_inspect(self.models.Item).column_attrs["label"].columns[0]
        with self.engine.begin() as connection:
            connection.execute(self.models.Item.__table__.insert(),
                               {"id": 1, label_column.name: "private-model-value", "price": 11, "quantity": 3})
            connection.execute(self.models.OtherItem.__table__.insert(), {"id": 1})
            for model in getattr(self.models, "ExtraModels", []):
                connection.execute(model.__table__.insert(), {"id": 1})
        self.api.Session = self.Session
        self.detach = studio.setup(self.api.app, self.root, development=True,
                                   engine=self.engine, sessions=self.Session, response_models=True)

    def tearDown(self):
        self.detach()
        self.detach_imports()
        self.engine.dispose()
        for suffix in self.sources:
            sys.modules.pop(self.name + "_" + suffix, None)
        if str(self.root) in sys.path:
            sys.path.remove(str(self.root))
        with studio._source_baseline_lock:
            studio._source_baselines.pop(self.root, None)
        self.temporary.cleanup()

    def request(self, client, path="/items"):
        return client.get(path, headers={"X-Studio-Trace": "runtime_model_request_123"})

    def line(self, suffix, statement):
        return next(index for index, line in enumerate(self.sources[suffix].splitlines(), 1)
                    if line.strip() == statement)

    def assert_site(self, site, suffix, statement, name):
        self.assertEqual(site, {"path": self.files[suffix].name,
                                "line": self.line(suffix, statement), "name": name,
                                "hash": hashlib.sha256(self.files[suffix].read_bytes()).hexdigest()})

    def test_actual_aliased_model_and_annotated_field_have_exact_declaration_sites(self):
        with TestClient(self.api.app) as client:
            ordinary = client.get("/items")
            response = self.request(client)
        self.assertEqual(response.json(), ordinary.json())
        trace = decode(response)
        origin = trace["fields"]["0.price"]
        self.assertEqual((origin["table"], origin["column"], origin["model"], origin["attribute"]),
                         ("model_items", "price", "Item", "price"))
        self.assert_site(origin["modelSource"], "models", "class Item(LabelMixin, Base):", "Item")
        self.assert_site(origin["fieldSource"], "models",
                         "price: Mapped[int] = mapped_column(Integer, nullable=False)", "price")
        self.assertEqual(origin["type"], "Integer")
        self.assertFalse(origin["nullable"])
        self.assertNotIn("private-model-value", json.dumps(trace))
        self.assertTrue(origin["queries"])

    def test_dictionary_response_keeps_loaded_model_and_actual_direct_field_claims(self):
        with TestClient(self.api.app) as client:
            ordinary = client.get("/dict-items")
            response = self.request(client, "/dict-items")
        self.assertEqual(response.json(), ordinary.json())
        trace = decode(response)
        self.assertEqual(set(trace["fields"]), {"0.price", "0.title"})
        self.assertEqual(trace["fields"]["0.price"]["column"], "price")
        self.assertEqual(trace["fields"]["0.title"]["attribute"], "label")
        self.assertEqual(len(trace["queries"]), 1)
        models = trace["queries"][0]["models"]
        self.assertEqual(len(models), 1)
        self.assertEqual(set(models[0]), {"model", "modelSource", "table"})
        self.assertEqual((models[0]["model"], models[0]["table"]), ("Item", "model_items"))
        self.assert_site(models[0]["modelSource"], "models", "class Item(LabelMixin, Base):", "Item")
        self.assertNotIn("private-model-value", json.dumps(trace))

    def test_many_loaded_rows_deduplicate_the_same_query_model(self):
        label = orm_inspect(self.models.Item).column_attrs["label"].columns[0].name
        with self.engine.begin() as connection:
            connection.execute(self.models.Item.__table__.insert(),
                               {"id": 2, label: "another-private-value", "price": 12, "quantity": 2})
        with TestClient(self.api.app) as client:
            response = self.request(client, "/dict-items")
        self.assertEqual(len(response.json()), 2)
        self.assertEqual(len(decode(response)["queries"][0]["models"]), 1)

    def test_interleaved_result_consumption_preserves_actual_query_model_correlation(self):
        with TestClient(self.api.app) as client:
            response = self.request(client, "/interleaved")
        self.assertEqual(response.json(), {"items": 1, "others": 1})
        trace = decode(response)
        self.assertEqual(trace["fields"], {})
        self.assertEqual([query["models"][0]["model"] for query in trace["queries"]],
                         ["Item", "OtherItem"])
        self.assertEqual([query["models"][0]["table"] for query in trace["queries"]],
                         ["model_items", "other_model_items"])

    def test_interleaved_same_model_response_fields_keep_the_query_that_loaded_each_instance(self):
        label = orm_inspect(self.models.Item).column_attrs["label"].columns[0].name
        with self.engine.begin() as connection:
            connection.execute(self.models.Item.__table__.insert(),
                               {"id": 2, label: "different-item", "price": 77, "quantity": 2})
        with TestClient(self.api.app) as client:
            response = self.request(client, "/interleaved-fields")
        self.assertEqual(response.json(), [{"displayTitle": "private-model-value", "price": 11}])
        trace = decode(response)
        queries = trace["queries"]
        self.assertEqual(len(queries), 2)
        self.assertNotEqual(queries[0]["id"], queries[1]["id"])
        self.assertEqual([query["models"][0]["model"] for query in queries], ["Item", "Item"])
        self.assertEqual(set(trace["fields"]), {"0.displayTitle", "0.price"})
        for origin in trace["fields"].values():
            self.assertEqual(origin["queries"], [queries[0]["id"]])

    def test_reused_identity_map_objects_are_not_claimed_as_new_query_model_loads(self):
        with TestClient(self.api.app) as client:
            response = self.request(client, "/reused")
        self.assertTrue(response.json()["same"])
        queries = decode(response)["queries"]
        self.assertEqual(queries[0]["models"][0]["model"], "Item")
        self.assertEqual(queries[1]["models"][0]["evidence"], "query-reference")
        self.assertEqual(queries[1]["models"][0]["model"], "Item")

    def test_scalar_column_queries_keep_actual_mapper_reference_without_loaded_or_field_claims(self):
        with TestClient(self.api.app) as client:
            response = self.request(client, "/columns")
        self.assertEqual(response.json(), [11])
        trace = decode(response)
        self.assertEqual(trace["fields"], {})
        self.assertIn("model_items", trace["queries"][0]["tables"])
        model = trace["queries"][0]["models"][0]
        self.assertEqual(model["model"], "Item")
        self.assertEqual(model["evidence"], "query-reference")
        self.assert_site(model["modelSource"], "models", "class Item(LabelMixin, Base):", "Item")

    def test_core_table_or_failed_scalar_select_cannot_guess_query_reference_classes(self):
        with TestClient(self.api.app) as client:
            core = decode(self.request(client, "/core-columns"))
            failed = decode(self.request(client, "/failed-columns"))
        self.assertEqual(core["fields"], {})
        self.assertNotIn("models", core["queries"][0])
        self.assertTrue(failed["queries"][0]["failed"])
        self.assertNotIn("models", failed["queries"][0])
        self.assertEqual(failed["fields"], {})

    def test_stale_model_class_file_omits_query_model_without_losing_query(self):
        with TestClient(self.api.app) as client:
            self.assertIn("models", decode(self.request(client, "/dict-items"))["queries"][0])
            self.files["models"].write_text(self.sources["models"] + "\n# edited class source\n", encoding="utf-8")
            response = self.request(client, "/dict-items")
        trace = decode(response)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(trace["fields"]), {"0.price", "0.title"})
        for origin in trace["fields"].values():
            self.assertNotIn("modelSource", origin)
        self.assertNotIn("fieldSource", trace["fields"]["0.price"])
        self.assertEqual(trace["fields"]["0.title"]["fieldSource"]["path"], self.files["mixins"].name)
        self.assertEqual(len(trace["queries"]), 1)
        self.assertNotIn("models", trace["queries"][0])

    @model_variant(lambda source: source + "\n" + "\n".join(
        f'class ExtraModel{index}(Base):\n'
        f'    __tablename__ = "extra_model_{index}"\n'
        '    id: Mapped[int] = mapped_column(primary_key=True)\n'
        for index in range(13)
    ) + "\nExtraModels = [" + ", ".join(f"ExtraModel{index}" for index in range(13)) + "]\n")
    def test_query_loaded_model_definitions_are_bounded(self):
        with TestClient(self.api.app) as client:
            response = self.request(client, "/many-models")
        self.assertEqual(response.json(), {"rows": 1})
        trace = decode(response)
        self.assertEqual(trace["fields"], {})
        self.assertEqual(len(trace["queries"]), 1)
        models = trace["queries"][0]["models"]
        self.assertEqual(len(models), 12)
        self.assertEqual(len({(model["modelSource"]["path"], model["modelSource"]["line"])
                              for model in models}), 12)

    def test_response_alias_and_inherited_column_keep_actual_attribute_and_base_file(self):
        with TestClient(self.api.app) as client:
            origin = decode(self.request(client))["fields"]["0.displayTitle"]
        self.assertEqual(origin["attribute"], "label")
        self.assertEqual(origin["column"], "display_label")
        self.assert_site(origin["modelSource"], "models", "class Item(LabelMixin, Base):", "Item")
        self.assert_site(origin["fieldSource"], "mixins",
                         'label: Mapped[str] = mapped_column("display_label", String, nullable=False)', "label")

    def test_computed_inputs_and_operation_leaves_keep_their_model_definitions(self):
        with TestClient(self.api.app) as client:
            response = self.request(client, "/computed")
        self.assertEqual(response.json(), [{"total": 33}])
        origin = decode(response)["fields"]["0.total"]
        self.assertEqual(origin["kind"], "computed")
        self.assertEqual([item["attribute"] for item in origin["inputs"]], ["price", "quantity"])
        self.assertEqual(origin["operation"]["left"]["modelSource"], origin["inputs"][0]["modelSource"])
        self.assertEqual(origin["operation"]["right"]["fieldSource"], origin["inputs"][1]["fieldSource"])
        quantity = origin["inputs"][1]
        self.assertTrue(quantity["nullable"])
        self.assert_site(quantity["fieldSource"], "models", "quantity = Column(Integer, nullable=True)", "quantity")

    def test_edited_model_source_removes_only_optional_definition_evidence(self):
        with TestClient(self.api.app) as client:
            self.assertIn("modelSource", decode(self.request(client))["fields"]["0.price"])
            self.files["models"].write_text(self.sources["models"] + "\n# edited after load\n", encoding="utf-8")
            response = self.request(client)
        self.assertEqual(response.status_code, 200)
        origin = decode(response)["fields"]["0.price"]
        self.assertEqual(origin["column"], "price")
        self.assertTrue(origin["queries"])
        self.assertNotIn("modelSource", origin)
        self.assertNotIn("fieldSource", origin)

    def test_unregistered_model_file_does_not_borrow_query_source_as_model_source(self):
        with studio._source_baseline_lock:
            studio._source_baselines[self.root].pop(self.files["models"].name)
        with TestClient(self.api.app) as client:
            origin = decode(self.request(client))["fields"]["0.price"]
        self.assertEqual(origin["column"], "price")
        self.assertNotIn("modelSource", origin)
        self.assertNotIn("fieldSource", origin)

    def test_same_named_nested_classes_use_qualnames_and_repeated_definitions_are_ambiguous(self):
        trace = studio.Trace(self.root, "nested_declaration_123")
        first = studio._model_declaration(trace, self.models.FirstNamespace.Twin)
        second = studio._model_declaration(trace, self.models.SecondNamespace.Twin)
        self.assertNotEqual(first["site"]["line"], second["site"]["line"])
        self.assertEqual(set(first["fields"]), {"first"})
        self.assertEqual(set(second["fields"]), {"second"})
        self.assertIsNone(studio._model_declaration(trace, self.models.FirstRepeated))
        self.assertIsNone(studio._model_declaration(trace, self.models.Repeated))

    def test_dynamically_added_column_has_no_fabricated_field_declaration(self):
        mapper = orm_inspect(self.models.Item)
        column = mapper.column_attrs["runtime"].columns[0]
        metadata = studio._orm_model_evidence(studio.Trace(self.root, "dynamic_model_123"), mapper, "runtime", column)
        self.assertIn("modelSource", metadata)
        self.assertNotIn("fieldSource", metadata)

    @model_variant(lambda source: source + '''
from sqlalchemy.orm import column_property
Item.price = column_property(Item.__table__.c.quantity)
''')
    def test_replaced_mapping_keeps_actual_query_column_without_old_field_highlight(self):
        with TestClient(self.api.app) as client:
            response = self.request(client)
        self.assertEqual(response.json()[0]["price"], 3)
        origin = decode(response)["fields"]["0.price"]
        self.assertEqual(origin["attribute"], "price")
        self.assertEqual(origin["column"], "quantity")
        self.assertIn("modelSource", origin)
        self.assertNotIn("fieldSource", origin)

    @model_variant(lambda source: source.replace(
        "from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column",
        "from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, declared_attr"
    ).replace("class Item(LabelMixin, Base):", '''class Item(LabelMixin, Base):
    @declared_attr
    def label(cls):
        return mapped_column("own_label", String, nullable=False)'''))
    def test_declared_attribute_override_does_not_borrow_inherited_field_source(self):
        with TestClient(self.api.app) as client:
            origin = decode(self.request(client))["fields"]["0.displayTitle"]
        self.assertEqual(origin["column"], "own_label")
        self.assertEqual(origin["attribute"], "label")
        self.assertIn("modelSource", origin)
        self.assertNotIn("fieldSource", origin)

    @model_variant(lambda source: source + '''
OldItem = Item
Item = type("Item", (Base,), {
    "__module__": __name__, "__tablename__": "runtime_items",
    "id": Column(Integer, primary_key=True), "label": Column(String),
    "price": Column(Integer), "quantity": Column(Integer),
})
ItemAlias = Item
''')
    def test_rebound_class_name_does_not_claim_old_class_or_field_declarations(self):
        with TestClient(self.api.app) as client:
            origin = decode(self.request(client))["fields"]["0.price"]
        self.assertEqual(origin["table"], "runtime_items")
        self.assertEqual(origin["column"], "price")
        self.assertEqual(origin["model"], "Item")
        self.assertNotIn("modelSource", origin)
        self.assertNotIn("fieldSource", origin)

    def test_model_metadata_does_not_bypass_same_value_orm_mutation_guard(self):
        with TestClient(self.api.app) as client:
            fields = decode(self.request(client, "/items?mutate=true"))["fields"]
        self.assertNotIn("0.price", fields)
        self.assertIn("modelSource", fields["0.displayTitle"])

    def test_custom_database_type_formatter_is_never_called_for_metadata(self):
        from types import SimpleNamespace
        class CustomType:
            def __str__(self):
                raise AssertionError("Custom SQL type formatter must not run")
        mapper = orm_inspect(self.models.Item)
        column = SimpleNamespace(type=CustomType(), nullable=True)
        metadata = studio._orm_model_evidence(studio.Trace(self.root, "custom_type_123"), mapper, "price", column)
        self.assertEqual(metadata["type"], "CustomType")
        self.assertTrue(metadata["nullable"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
