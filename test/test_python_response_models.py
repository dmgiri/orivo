"""Generic, disposable FastAPI/SQLAlchemy acceptance for the portable SDK.

Run with an existing development Python environment; no application is edited.
"""
import base64
import json
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace
from typing import Annotated

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "adapters" / "tracing"))
import studio_tracing as studio
import fastapi.routing
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import (AfterValidator, BaseModel, ConfigDict, Field, computed_field,
                      field_serializer, field_validator, model_serializer, model_validator)
from sqlalchemy import Column, Integer, String, create_engine, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import StaticPool

Base = declarative_base()


class CatalogEntry(Base):
    __tablename__ = "acceptance_catalog"
    id = Column(Integer, primary_key=True)
    title = Column(String)
    unrelated = Column(String)

    @property
    def shadow_title(self):
        return self.title


class DirectLabel(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    label: str = Field(validation_alias="title", serialization_alias="displayLabel")


class Envelope(BaseModel):
    entries: list[DirectLabel]


class NameFallback(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    title: str = Field(alias="missing_alias")


class PropertyAlias(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    title: str = Field(validation_alias="shadow_title")


class FieldValidatorLabel(DirectLabel):
    @field_validator("label")
    @classmethod
    def unchanged(cls, value):
        return value


class ModelValidatorLabel(DirectLabel):
    @model_validator(mode="after")
    def unchanged(self):
        return self


class FieldSerializerLabel(DirectLabel):
    @field_serializer("label")
    def changed(self, value):
        return value.upper()


class ModelSerializerLabel(DirectLabel):
    @model_serializer
    def changed(self):
        return {"displayLabel": self.label.upper()}


class ComputedLabel(DirectLabel):
    @computed_field
    @property
    def computed(self) -> str:
        return self.label.upper()


class AnnotatedValidatorLabel(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    label: Annotated[str, AfterValidator(lambda value: value)] = Field(validation_alias="title")


def decode(response):
    encoded = response.headers["Studio-Trace"]
    data = base64.b64decode(encoded[3:] if encoded.startswith("z1.") else encoded)
    return json.loads(zlib.decompress(data) if encoded.startswith("z1.") else data)


class ResponseModelTests(unittest.TestCase):
    def setUp(self):
        self.original_serializer = fastapi.routing.serialize_response
        self.engine = create_engine("sqlite://", poolclass=StaticPool,
                                    connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(self.engine)
        with self.Session() as session:
            # Equal values in different attributes must not choose the origin.
            session.add_all([CatalogEntry(id=1, title="private-same", unrelated="private-same"),
                             CatalogEntry(id=2, title="private-second", unrelated="private-second")])
            session.commit()
        self.detach = []

    def tearDown(self):
        for detach in reversed(self.detach):
            detach()
            detach()
        self.engine.dispose()
        self.assertIs(fastapi.routing.serialize_response, self.original_serializer)

    def app(self, enabled=True, **options):
        app = FastAPI()
        self.detach.append(studio.setup(app, Path(__file__).parent, development=True,
                                        engine=self.engine, sessions=self.Session,
                                        response_models=enabled, **options))
        return app

    def rows(self):
        with self.Session() as session:
            return session.scalars(select(CatalogEntry).order_by(CatalogEntry.id)).all()

    def tracked(self, client, path="/catalog"):
        return client.get(path, headers={"X-Studio-Trace": "independent_catalog_123"})

    def assert_origin(self, trace, path):
        origin = trace["fields"][path]
        self.assertEqual(origin["table"], "acceptance_catalog")
        self.assertEqual(origin["column"], "title")
        self.assertEqual(origin["model"], "CatalogEntry")
        query = next(query for query in trace["queries"] if query["id"] in origin["queries"])
        self.assertFalse(query["failed"])
        self.assertIn("acceptance_catalog.title", query["columns"])
        self.assertTrue(query["site"]["hash"])
        self.assertNotIn("private-", json.dumps(trace))

    def test_plain_orm_list_envelope_and_aliases_capture_exact_fields(self):
        app = self.app()
        @app.get("/catalog", response_model=Envelope)
        def catalog():
            return {"entries": self.rows()}
        @app.get("/one", response_model=DirectLabel)
        def one():
            return self.rows()[0]
        @app.get("/list", response_model=list[DirectLabel])
        def collection():
            return self.rows()
        @app.get("/map", response_model=dict[str, DirectLabel])
        def mapping():
            return {"entry": self.rows()[0]}
        with TestClient(app) as client:
            ordinary = client.get("/catalog")
            response = self.tracked(client)
            self.assertEqual(response.json(), ordinary.json())
            trace = decode(response)
            self.assertEqual(set(trace["fields"]), {"entries.0.displayLabel", "entries.1.displayLabel"})
            self.assert_origin(trace, "entries.1.displayLabel")
            self.assert_origin(decode(self.tracked(client, "/one")), "displayLabel")
            self.assert_origin(decode(self.tracked(client, "/list")), "1.displayLabel")
            self.assert_origin(decode(self.tracked(client, "/map")), "entry.displayLabel")
            self.assertNotIn("Studio-Trace", ordinary.headers)

    def test_output_alias_switch_and_population_fallback_are_structural(self):
        app = self.app()
        @app.get("/catalog", response_model=DirectLabel, response_model_by_alias=False)
        def catalog():
            return self.rows()[0]
        @app.get("/fallback", response_model=NameFallback)
        def fallback():
            return self.rows()[0]
        with TestClient(app) as client:
            self.assert_origin(decode(self.tracked(client)), "label")
            self.assert_origin(decode(self.tracked(client, "/fallback")), "missing_alias")

    def test_custom_validation_serialization_and_computed_fields_do_not_claim_columns(self):
        models = [FieldValidatorLabel, ModelValidatorLabel, FieldSerializerLabel,
                  ModelSerializerLabel, ComputedLabel, AnnotatedValidatorLabel]
        app = self.app()
        for index, model in enumerate(models):
            def endpoint():
                return self.rows()[0]
            app.get(f"/unsafe/{index}", response_model=model)(endpoint)
        with TestClient(app) as client:
            for index, model in enumerate(models):
                with self.subTest(model=model.__name__):
                    response = self.tracked(client, f"/unsafe/{index}")
                    self.assertEqual(response.status_code, 200)
                    trace = decode(response)
                    self.assertTrue(trace["queries"])
                    self.assertEqual(trace["fields"], {})

    def test_modified_orm_and_prebuilt_dtos_remain_unproven(self):
        app = self.app()
        @app.get("/catalog", response_model=DirectLabel)
        def catalog():
            row = self.rows()[0]
            row.title = "changed-value"
            return row
        @app.get("/dto", response_model=DirectLabel)
        def dto():
            return DirectLabel.model_validate(self.rows()[0])
        with TestClient(app) as client:
            self.assertEqual(self.tracked(client).json(), {"displayLabel": "changed-value"})
            self.assertEqual(decode(self.tracked(client))["fields"], {})
            self.assertEqual(decode(self.tracked(client, "/dto"))["fields"], {})

    def test_property_alias_is_not_reassigned_to_equal_mapped_attribute(self):
        app = self.app()
        @app.get("/catalog", response_model=PropertyAlias)
        def catalog():
            return self.rows()[0]
        with TestClient(app) as client:
            response = self.tracked(client)
            self.assertEqual(response.json(), {"title": "private-same"})
            self.assertTrue(decode(response)["queries"])
            self.assertEqual(decode(response)["fields"], {})

    def test_reused_identity_map_is_not_assigned_to_current_request(self):
        app = self.app()
        session = self.Session()
        cached = session.scalars(select(CatalogEntry)).first()
        @app.get("/catalog", response_model=DirectLabel)
        def catalog():
            # This SELECT executes, but the object was loaded before this trace.
            return session.scalars(select(CatalogEntry).where(CatalogEntry.id == cached.id)).one()
        try:
            with TestClient(app) as client:
                trace = decode(self.tracked(client))
                self.assertTrue(trace["queries"])
                self.assertEqual(trace["fields"], {})
        finally:
            session.close()

    def test_excluded_fields_and_default_opt_out_never_publish_origins(self):
        app = self.app()
        @app.get("/catalog", response_model=DirectLabel, response_model_exclude={"label"})
        def catalog():
            return self.rows()[0]
        with TestClient(app) as client:
            response = self.tracked(client)
            self.assertEqual(response.json(), {})
            self.assertEqual(decode(response)["fields"], {})
        off = self.app(enabled=False)
        @off.get("/catalog", response_model=DirectLabel)
        def disabled():
            return self.rows()[0]
        with TestClient(off) as client:
            self.assertEqual(decode(self.tracked(client))["fields"], {})

    def test_shared_hook_is_app_scoped_and_detaches_out_of_order(self):
        first, second = self.app(), self.app()
        wrapper = fastapi.routing.serialize_response
        self.assertIsNot(wrapper, self.original_serializer)
        for app in (first, second):
            @app.get("/catalog", response_model=DirectLabel)
            def catalog():
                return self.rows()[0]
        self.detach[0]()
        self.assertIs(fastapi.routing.serialize_response, wrapper)
        with TestClient(first) as a, TestClient(second) as b:
            self.assertEqual(decode(self.tracked(a))["fields"], {})
            self.assert_origin(decode(self.tracked(b)), "displayLabel")
        self.detach[1]()
        self.assertIs(fastapi.routing.serialize_response, self.original_serializer)

    def test_async_engine_and_session_event_targets_are_normalized(self):
        factory = async_sessionmaker()
        app = FastAPI()
        detach = studio.setup(app, Path(__file__).parent, development=True,
                              engine=SimpleNamespace(sync_engine=self.engine),
                              sessions=factory, response_models=True)
        self.detach.append(detach)
        @app.get("/catalog", response_model=DirectLabel)
        def catalog():
            with factory.class_.sync_session_class(bind=self.engine) as session:
                return session.scalars(select(CatalogEntry)).first()
        with TestClient(app) as client:
            self.assert_origin(decode(self.tracked(client)), "displayLabel")
        for target in (AsyncSession, AsyncSession()):
            remove = studio.attach_orm(target)
            remove()
        # Disabled setup must not install hooks or mutate app middleware.
        disabled = FastAPI()
        before = list(disabled.user_middleware)
        close = studio.setup(disabled, Path(__file__).parent, development=False,
                             response_models=True)
        close()
        self.assertEqual(disabled.user_middleware, before)

    def test_startup_snapshot_rejects_edited_route_before_first_request(self):
        with tempfile.TemporaryDirectory(prefix="anvaya-python-freshness-") as directory:
            root = Path(directory).resolve()
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith("anvaya-python-freshness-"))
            source_file = root / "catalog_api.py"
            source = (
                "from fastapi import FastAPI\n"
                "from pydantic import BaseModel, ConfigDict, Field\n"
                "from sqlalchemy import select\n"
                "class Output(BaseModel):\n"
                "    model_config=ConfigDict(from_attributes=True)\n"
                "    label:str=Field(validation_alias='title')\n"
                "app=FastAPI()\n"
                "detach=studio.setup(app, ROOT, development=True, engine=engine, sessions=Session, response_models=True)\n"
                "@app.get('/catalog',response_model=Output)\n"
                "def catalog():\n"
                "    with Session() as session:\n"
                "        return session.scalars(select(CatalogEntry)).first()\n"
            )
            source_file.write_text(source, encoding="utf-8")
            scope = {"__name__": "anvaya_freshness_route", "__file__": str(source_file),
                     "studio": studio, "ROOT": root, "engine": self.engine,
                     "Session": self.Session, "CatalogEntry": CatalogEntry}
            exec(compile(source, str(source_file), "exec"), scope)
            self.detach.append(scope["detach"])
            self.assertIsNotNone(studio.Trace(root, "baseline_check_123").site(str(source_file), 10, "catalog"))
            # The loaded function is unchanged; disk bytes now describe a
            # different version, before any traced HTTP request has occurred.
            source_file.write_text(source + "\n# Edited after registration.\n", encoding="utf-8")
            self.assertIsNone(studio.Trace(root, "baseline_check_456").site(str(source_file), 10, "catalog"))
            with TestClient(scope["app"]) as client:
                response = self.tracked(client)
                self.assertEqual(response.json(), {"label": "private-same"})
                trace = decode(response)
                self.assertIsNone(trace["route"])
                self.assertTrue(trace["queries"])
                self.assertIsNone(trace["queries"][0]["site"])
                self.assertEqual(trace["fields"], {})
                source_file.write_text(source, encoding="utf-8")
                self.assert_origin(decode(self.tracked(client)), "label")

    def test_changed_query_helper_cannot_fall_back_to_fresh_route_source(self):
        with tempfile.TemporaryDirectory(prefix="anvaya-python-freshness-") as directory:
            root = Path(directory).resolve()
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith("anvaya-python-freshness-"))
            helper_file, route_file = root / "query_helpers.py", root / "catalog_api.py"
            helper = ("from sqlalchemy import select\n"
                      "def load_row(Session, CatalogEntry):\n"
                      "    with Session() as session:\n"
                      "        return session.scalars(select(CatalogEntry)).first()\n")
            route = ("from fastapi import FastAPI\n"
                     "app=FastAPI()\n"
                     "@app.get('/catalog',response_model=Output)\n"
                     "def catalog():\n"
                     "    return load_row(Session, CatalogEntry)\n"
                     "detach=studio.setup(app,ROOT,development=True,engine=engine,sessions=Session,response_models=True)\n")
            helper_file.write_text(helper, encoding="utf-8")
            route_file.write_text(route, encoding="utf-8")
            helper_scope = {"__name__": "anvaya_freshness_query"}
            exec(compile(helper, str(helper_file), "exec"), helper_scope)
            scope = {"__name__": "anvaya_freshness_route", "Output": DirectLabel,
                     "studio": studio, "ROOT": root, "engine": self.engine,
                     "Session": self.Session, "CatalogEntry": CatalogEntry,
                     "load_row": helper_scope["load_row"]}
            exec(compile(route, str(route_file), "exec"), scope)
            self.detach.append(scope["detach"])
            helper_file.write_text(helper + "\n# Stale loaded query helper.\n", encoding="utf-8")
            with TestClient(scope["app"]) as client:
                trace = decode(self.tracked(client))
                self.assertIsNotNone(trace["route"])
                self.assertTrue(trace["queries"])
                self.assertIsNone(trace["queries"][0]["site"])
                self.assertEqual(trace["queries"][0]["frames"], [])
                self.assertEqual(trace["fields"], {})

    def test_python_snapshot_excludes_sensitive_generated_and_new_sources(self):
        with tempfile.TemporaryDirectory(prefix="anvaya-python-freshness-") as directory:
            root = Path(directory).resolve()
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith("anvaya-python-freshness-"))
            for relative in ("ordinary.py", ".hidden.py", "credentials.py", "build/generated.py",
                             "node_modules/embedded.py", ".venv/package.py", "archives/old.py"):
                full = root / relative
                full.parent.mkdir(parents=True, exist_ok=True)
                full.write_text("pass\n", encoding="utf-8")
            (root / "oversized.py").write_bytes(b"#" * 262145)
            trace = studio.Trace(root, "snapshot_filters_123")
            self.assertIsNotNone(trace.site(str(root / "ordinary.py"), 1, "ordinary"))
            for relative in (".hidden.py", "credentials.py", "build/generated.py", "oversized.py",
                             "node_modules/embedded.py", ".venv/package.py", "archives/old.py"):
                self.assertIsNone(trace.site(str(root / relative), 1, "excluded"))
            (root / "added_later.py").write_text("pass\n", encoding="utf-8")
            self.assertIsNone(studio.Trace(root, "snapshot_filters_456").site(str(root / "added_later.py"), 1, "new"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
