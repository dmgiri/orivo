"""Automatic attachment against an unmodified, independent FastAPI project."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
import zlib

sys.dont_write_bytecode = True
ADAPTER = Path(__file__).resolve().parents[1] / 'adapters' / 'tracing'
sys.path.insert(0, str(ADAPTER))
spec = importlib.util.spec_from_file_location('anvaya_auto_python', ADAPTER / 'auto_python.py')
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)
from fastapi.testclient import TestClient

APPLICATION = '''from contextlib import asynccontextmanager
from types import SimpleNamespace
from fastapi import FastAPI
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, select
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import StaticPool
Base=declarative_base()
events=[]
class Shipment(Base):
    __tablename__='shipment_records'
    id=Column(Integer,primary_key=True)
    reference=Column(String)
class Output(BaseModel):
    label:str
def create_app():
    events.append('factory')
    @asynccontextmanager
    async def lifespan(app):
        events.append('startup')
        engine=create_engine('sqlite://',poolclass=StaticPool,connect_args={'check_same_thread':False})
        sessions=sessionmaker(engine)
        Base.metadata.create_all(engine)
        with sessions() as session:
            session.add(Shipment(id=1,reference='shipment-reference'))
            session.commit()
        app.state.database=SimpleNamespace(engine=engine,session_factory=sessions)
        try:
            yield {'original':'retained'}
        finally:
            events.append('shutdown')
            engine.dispose()
    app=FastAPI(lifespan=lifespan)
    @app.get('/shipments',response_model=list[Output])
    def shipments():
        with app.state.database.session_factory() as session:
            rows=session.scalars(select(Shipment)).all()
            return [Output(label=row.reference) for row in rows]
    return app
'''


def decode(response, client=None, token=None, base=None):
    header = response.headers['studio-trace']
    raw = base64.b64decode(header[3:] if header.startswith('z1.') else header)
    trace = json.loads(zlib.decompress(raw) if header.startswith('z1.') else raw)
    if trace.get('ref') == 'anvaya-managed-v1':
        route = '/__anvaya_trace/' + token + '/' + trace['key']
        if client is not None:
            metadata = client.get(route)
            assert metadata.status_code == 200
            trace = metadata.json()
        else:
            with urllib.request.urlopen(base + route, timeout=3) as metadata:
                trace = json.load(metadata)
    return trace


class AutomaticPythonTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='anvaya-auto-python-')
        self.root = Path(self.temporary.name)
        self.name = 'shipment_api_' + uuid.uuid4().hex
        self.file = self.root / (self.name + '.py')
        self.file.write_text(APPLICATION, encoding='utf-8')
        self.token = 'managed_test_' + uuid.uuid4().hex
        self.config = dict(root=str(self.root), app=self.name + ':create_app', factory=True,
                           sourcePaths=[str(self.root)], readyToken=self.token)

    def tearDown(self):
        sys.modules.pop(self.name, None)
        if str(self.root) in sys.path:
            sys.path.remove(str(self.root))
        self.temporary.cleanup()

    def test_factory_lifespan_created_once_and_real_query_dto_origin_captured(self):
        original = self.file.read_bytes()
        app = managed.create_managed_app(self.config)
        with TestClient(app) as client:
            response = client.get('/shipments', headers={'X-Studio-Trace': 'anvaya_shipping_request'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), [{'label': 'shipment-reference'}])
            trace = decode(response, client, self.token)
            self.assertEqual(len(trace['queries']), 1)
            self.assertIn('SELECT', trace['queries'][0]['sql'])
            self.assertEqual(trace['fields']['0.label']['table'], 'shipment_records')
            self.assertEqual(trace['fields']['0.label']['column'], 'reference')
            self.assertEqual(trace['fields']['0.label']['projection']['path'], self.name + '.py')
            self.assertEqual(sys.modules[self.name].events, ['factory', 'startup'])
            ready = client.get('/__anvaya_managed_ready/' + self.token)
            self.assertEqual((ready.status_code, ready.text), (200, self.token))
            self.assertEqual(ready.headers['cache-control'], 'no-store')
            self.assertEqual(client.get('/__anvaya_managed_ready/wrong_token').status_code, 404)
            # No trace header leaks into ordinary development requests.
            self.assertNotIn('studio-trace', client.get('/shipments').headers)
        self.assertEqual(sys.modules[self.name].events, ['factory', 'startup', 'shutdown'])
        self.assertEqual(self.file.read_bytes(), original)
        self.assertFalse((self.root / '__pycache__').exists())

    def test_computed_response_does_not_receive_invented_origin(self):
        self.file.write_text(APPLICATION.replace('label=row.reference)', 'label=row.reference.upper())'), encoding='utf-8')
        with TestClient(managed.create_managed_app(self.config)) as client:
            response = client.get('/shipments', headers={'X-Studio-Trace': 'anvaya_computed_request'})
            self.assertEqual(response.json(), [{'label': 'SHIPMENT-REFERENCE'}])
            self.assertEqual(decode(response, client, self.token)['fields'], {})

    def test_existing_optional_sdk_integration_does_not_duplicate_context_or_queries(self):
        source = APPLICATION.replace('from fastapi import FastAPI', 'from fastapi import FastAPI\nimport studio_tracing')
        source = source.replace('def create_app():', "legacy_engine=create_engine('sqlite://',poolclass=StaticPool,connect_args={'check_same_thread':False})\nlegacy_sessions=sessionmaker(legacy_engine)\ndef create_app():")
        source = source.replace("engine=create_engine('sqlite://',poolclass=StaticPool,connect_args={'check_same_thread':False})\n        sessions=sessionmaker(engine)", 'engine=legacy_engine\n        sessions=legacy_sessions')
        source = source.replace('engine.dispose()', 'detach_legacy()\n            engine.dispose()')
        source = source.replace('app=FastAPI(lifespan=lifespan)', 'app=FastAPI(lifespan=lifespan)\n    detach_legacy=studio_tracing.setup(app,__file__.rsplit("/",1)[0] if "/" in __file__ else __file__.rsplit(chr(92),1)[0],development=True,engine=legacy_engine,sessions=legacy_sessions,response_models=True)')
        self.file.write_text(source, encoding='utf-8')
        with TestClient(managed.create_managed_app(self.config)) as client:
            response = client.get('/shipments', headers={'X-Studio-Trace': 'anvaya_existing_integration'})
            trace = decode(response, client, self.token)
            self.assertEqual(len(trace['queries']), 1)
            self.assertEqual(trace['fields']['0.label']['column'], 'reference')

    def test_discovers_async_engine_and_session_factory_without_connecting(self):
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
        import types
        engine = create_async_engine('postgresql+psycopg://unused:unused@127.0.0.1:1/unused')
        session_factory = async_sessionmaker(engine)
        app = types.SimpleNamespace(state=types.SimpleNamespace(database={'engine': engine, 'sessions': session_factory}))
        try:
            engines, sessions = managed.discover_sqlalchemy(app, self.root)
            self.assertEqual(engines, [engine.sync_engine])
            self.assertEqual(sessions, [AsyncSession.sync_session_class])
        finally:
            engine.sync_engine.dispose()

    def test_owned_cli_serves_verified_trace_without_source_edits(self):
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        configuration = self.root / 'managed-config.json'
        configuration.write_text(json.dumps({**self.config, 'host': '127.0.0.1', 'port': port}), encoding='utf-8')
        original = self.file.read_bytes()
        process = subprocess.Popen([sys.executable, '-B', str(ADAPTER / 'auto_python.py'), '--config', str(configuration)],
                                   cwd=self.root, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        base = 'http://127.0.0.1:' + str(port)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    self.fail('Managed backend exited before readiness: ' + process.stderr.read()[-2000:])
                try:
                    with urllib.request.urlopen(base + '/__anvaya_managed_ready/' + self.token, timeout=0.3) as response:
                        self.assertEqual(response.read().decode(), self.token)
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.05)
            else:
                self.fail('Managed backend did not become ready')
            request = urllib.request.Request(base + '/shipments', headers={'X-Studio-Trace': 'anvaya_owned_cli_request'})
            with urllib.request.urlopen(request, timeout=3) as response:
                self.assertEqual(json.load(response), [{'label': 'shipment-reference'}])
                trace = decode(response, token=self.token, base=base)
            self.assertEqual(len(trace['queries']), 1)
            self.assertEqual(trace['fields']['0.label']['column'], 'reference')
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(self.file.read_bytes(), original)
        self.assertFalse((self.root / '__pycache__').exists())

    def test_rejects_source_root_outside_repository_before_import(self):
        self.config['sourcePaths'] = [str(self.root.parent)]
        with self.assertRaisesRegex(ValueError, 'inside the repository'):
            managed.create_managed_app(self.config)
        self.assertNotIn(self.name, sys.modules)

    def test_starlette_lifespan_and_request_trace_work_without_response_model_hooks(self):
        self.file.write_text('''from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
async def status(request): return JSONResponse({'ready':True})
app=Starlette(routes=[Route('/status',status)])
''', encoding='utf-8')
        self.config.update(app=self.name + ':app', factory=False)
        with TestClient(managed.create_managed_app(self.config)) as client:
            response = client.get('/status', headers={'X-Studio-Trace': 'anvaya_starlette_request'})
            self.assertEqual(response.json(), {'ready': True})
            self.assertEqual(decode(response, client, self.token)['route']['name'], 'status')
            self.assertEqual(client.get('/__anvaya_managed_ready/' + self.token).text, self.token)


if __name__ == '__main__':
    unittest.main()
