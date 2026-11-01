"""Anvaya-owned development host. Never writes to the selected application."""
from __future__ import annotations

import argparse
from contextlib import ExitStack, asynccontextmanager
from functools import wraps
from importlib import import_module
import json
import os
from pathlib import Path
import re
import sys
import types
from typing import Any
from managed_trace_store import ManagedTraceStore

sys.dont_write_bytecode = True


def _share_sdk_listeners(studio: Any, hooks: ExitStack) -> None:
    """Share this SDK's listeners with an existing optional integration.

    This changes only functions in the owned process's adapter module. It does
    not modify target modules or settings. Separate legacy adapters keep their
    own context, and the outer managed middleware owns the returned header.
    """
    for name in ('attach_sqlalchemy', 'attach_orm'):
        original = getattr(studio, name)
        registrations: dict[int, dict[str, Any]] = {}

        def make_shared(function: Any, records: dict[int, dict[str, Any]], kind: str):
            @wraps(function)
            def shared(target: Any):
                if kind == 'attach_sqlalchemy':
                    target = getattr(target, 'sync_engine', target)
                else:
                    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
                    from sqlalchemy.orm import sessionmaker
                    if isinstance(target, (sessionmaker, async_sessionmaker)):
                        target = target.class_
                    if isinstance(target, AsyncSession):
                        target = target.sync_session
                    elif isinstance(target, type) and issubclass(target, AsyncSession):
                        target = target.sync_session_class
                key = id(target)
                if key not in records:
                    records[key] = {'target': target, 'detach': function(target), 'references': 0}
                registration = records[key]
                registration['references'] += 1
                removed = False

                def remove():
                    nonlocal removed
                    if not removed:
                        removed = True
                        registration['references'] -= 1
                        if registration['references'] == 0:
                            records.pop(key, None)
                            registration['detach']()
                return remove
            return shared

        shared = make_shared(original, registrations, name)
        setattr(studio, name, shared)
        # Restore after the app's lifespan and listeners have shut down. The
        # process normally exits, but restoration also supports isolated tests.
        hooks.callback(setattr, studio, name, original)


def _inside(root: Path, filename: Any) -> bool:
    try:
        return isinstance(filename, str) and Path(filename).resolve().is_relative_to(root)
    except (ValueError, OSError):
        return False


def discover_sqlalchemy(application: Any, root: Path) -> tuple[list[Any], list[Any]]:
    """Inspect ordinary object dictionaries, never application properties.

    Discovery runs after the application's original lifespan starts. Only
    loaded repository modules and app.state are roots; bounded traversal avoids
    connections, getters, arbitrary iterators, and unrelated library modules.
    """
    try:
        from sqlalchemy.engine import Engine
        from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
        from sqlalchemy.orm import Session, sessionmaker, scoped_session
    except ImportError:
        return [], []
    engines: dict[int, Any] = {}
    sessions: dict[int, Any] = {}
    seen: set[int] = set()
    pending: list[tuple[Any, int]] = []
    for module in tuple(sys.modules.values()):
        if isinstance(module, types.ModuleType) and _inside(root, vars(module).get('__file__')):
            pending.extend((value, 0) for value in tuple(vars(module).values())[:2000])
    state = vars(application).get('state')
    if state is not None:
        pending.append((state, 0))
    visits = 0
    while pending and visits < 12000:
        value, depth = pending.pop()
        if id(value) in seen:
            continue
        seen.add(id(value))
        visits += 1
        if isinstance(value, AsyncEngine):
            engine = value.sync_engine
            engines[id(engine)] = engine
            continue
        if isinstance(value, Engine):
            engines[id(value)] = value
            continue
        if isinstance(value, (sessionmaker, async_sessionmaker)):
            target = value.class_
            if issubclass(target, AsyncSession):
                target = target.sync_session_class
            sessions[id(target)] = target
            bind = value.kw.get('bind')
            if bind is not None:
                pending.append((bind, depth))
            continue
        if isinstance(value, scoped_session):
            pending.append((value.session_factory, depth))
            continue
        if isinstance(value, AsyncSession):
            sessions[id(value.sync_session)] = value.sync_session
            if value.bind is not None:
                pending.append((value.bind, depth))
            continue
        if isinstance(value, Session):
            sessions[id(value)] = value
            if value.bind is not None:
                pending.append((value.bind, depth))
            continue
        # An imported Session class supports apps using `with Session(engine)`.
        # Event callbacks still only observe this adapter's request context.
        if isinstance(value, type):
            if issubclass(value, AsyncSession):
                target = value.sync_session_class
                sessions[id(target)] = target
            elif issubclass(value, Session):
                sessions[id(value)] = value
            continue
        if depth >= 4 or isinstance(value, (str, bytes, int, float, bool, type(None), types.ModuleType, types.FunctionType)):
            continue
        if type(value) is dict:
            children = tuple(value.values())[:1000]
        elif type(value) in (list, tuple):
            children = value[:1000]
        else:
            try:
                dictionary = object.__getattribute__(value, '__dict__')
                children = tuple(dictionary.values())[:1000] if type(dictionary) is dict else ()
            except (AttributeError, TypeError):
                children = ()
        pending.extend((child, depth + 1) for child in children)
    # A listener on Session covers subclasses too; avoid duplicate callbacks.
    if id(Session) in sessions:
        sessions = {id(Session): Session}
    return list(engines.values()), list(sessions.values())


class ManagedReady:
    def __init__(self, app: Any, token: str, state: dict[str, Any],
                 traces: ManagedTraceStore | None = None) -> None:
        self.app, self.token, self.state, self.traces = app, token, state, traces

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope['type'] == 'http' and scope.get('path', '').startswith('/__anvaya_trace/'):
            prefix = '/__anvaya_trace/' + self.token + '/'
            key = scope.get('path', '')[len(prefix):] if self.token and scope.get('path', '').startswith(prefix) else ''
            raw = self.traces.get(key) if self.traces and scope.get('method') == 'GET' and not scope.get('query_string') else None
            await send({'type': 'http.response.start', 'status': 200 if raw is not None else 404,
                        'headers': [(b'content-type', b'application/json'), (b'cache-control', b'no-store'),
                                    (b'x-content-type-options', b'nosniff')]})
            await send({'type': 'http.response.body', 'body': raw if raw is not None else b'{}'})
            return
        if (self.token and scope['type'] == 'http'
                and scope.get('method') == 'GET'
                and scope.get('path') == '/__anvaya_managed_ready/' + self.token):
            ready = self.state['ready']
            await send({'type': 'http.response.start', 'status': 200 if ready else 503,
                        'headers': [(b'content-type', b'text/plain'), (b'cache-control', b'no-store')]})
            await send({'type': 'http.response.body', 'body': self.token.encode() if ready else b'starting'})
            return
        await self.app(scope, receive, send)


def create_managed_app(config: dict[str, Any]) -> Any:
    import studio_tracing
    from starlette.applications import Starlette
    root = Path(config['root']).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('The repository root must be an existing directory')
    reference = config['app']
    if not isinstance(reference, str) or not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*', reference):
        raise ValueError('Choose a module:app or module:create_app entry point')
    paths = config.get('sourcePaths')
    if not isinstance(paths, list) or not 1 <= len(paths) <= 16:
        raise ValueError('Choose one to sixteen repository source roots')
    includes, source_directories = [], []
    for raw in paths:
        directory = Path(raw).resolve(strict=True)
        if not directory.is_dir() or not directory.is_relative_to(root):
            raise ValueError('Source roots must stay inside the repository')
        includes.append(directory.relative_to(root).as_posix() or '.')
        source_directories.append(directory)
    for directory in reversed(source_directories):
        if str(directory) not in sys.path:
            sys.path.insert(0, str(directory))
    token = config.get('readyToken', '')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,100}|', token):
        raise ValueError('Invalid managed readiness token')
    hooks = ExitStack()
    try:
        _share_sdk_listeners(studio_tracing, hooks)
        hooks.callback(studio_tracing.instrument_project(root, include=includes))
        module, member = reference.split(':')
        application_module = import_module(module)
        if not _inside(root, vars(application_module).get('__file__')):
            raise ValueError('The application entry must resolve inside the repository')
        application = getattr(application_module, member)
        if config.get('factory') is True:
            application = application()
        if not isinstance(application, Starlette):
            raise ValueError('Automatic Python attachment currently supports FastAPI and Starlette applications')
        try:
            from fastapi import FastAPI
            response_models = isinstance(application, FastAPI)
        except ImportError:
            response_models = False
        # An existing optional integration can have installed this same SDK's
        # request middleware while importing the app. One outer middleware is
        # needed: nested copies create separate contexts and lose inner queries.
        application.user_middleware[:] = [
            entry for entry in application.user_middleware
            if getattr(getattr(entry, 'kwargs', {}).get('dispatch'), '__module__', None) != studio_tracing.__name__
        ]
        # Reuse one application and its original startup/shutdown. Instrument
        # before importing it; install middleware before Starlette builds its
        # stack. Engine/session objects may not exist until lifespan startup.
        traces = ManagedTraceStore()
        hooks.callback(traces.close)
        hooks.callback(studio_tracing.setup(application, root, development=True,
                                           response_models=response_models,
                                           publish_trace=traces.publish if token else None))
        original = application.router.lifespan_context
        state = {'ready': False}

        @asynccontextmanager
        async def lifespan(app: Any):
            with hooks:
                async with original(app) as original_state:
                    engines, sessions = discover_sqlalchemy(app, root)
                    for engine in engines:
                        hooks.callback(studio_tracing.attach_sqlalchemy(engine))
                    for factory in sessions:
                        hooks.callback(studio_tracing.attach_orm(factory))
                    state['ready'] = True
                    print(json.dumps({'anvaya': 'python-ready', 'framework': 'FastAPI' if response_models else 'Starlette',
                                      'engines': len(engines), 'sessions': len(sessions)}), flush=True)
                    try:
                        yield original_state
                    finally:
                        state['ready'] = False

        application.router.lifespan_context = lifespan
        return ManagedReady(application, token, state, traces)
    except BaseException:
        hooks.close()
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description='Run an Anvaya-owned local tracing backend')
    parser.add_argument('--config', required=True)
    arguments = parser.parse_args()
    config_file = Path(arguments.config)
    if config_file.stat().st_size > 65536:
        raise ValueError('Managed backend configuration is too large')
    config = json.loads(config_file.read_text(encoding='utf-8'))
    port = config.get('port')
    if (config.get('host', '127.0.0.1') != '127.0.0.1' or not isinstance(port, int)
            or isinstance(port, bool) or not 1024 <= port <= 65535):
        raise ValueError('The managed backend requires a local unprivileged port')
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    import uvicorn
    application = create_managed_app(config)
    uvicorn.run(application, host='127.0.0.1', port=port, access_log=False,
                reload=False, log_level='warning', server_header=False)


if __name__ == '__main__':
    main()
