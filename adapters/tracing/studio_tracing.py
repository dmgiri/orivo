"""Opt-in development execution capture. No SQL parameter values or response bodies."""

from __future__ import annotations

import base64
import builtins
import ast
import contextvars
import gc
import hashlib
import inspect
import importlib.abc
import importlib.machinery
import json
import itertools
import math
import operator
import os
import re
import sys
import threading
import time
import types
import uuid
import weakref
import zlib
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import date, datetime, timezone
from enum import Enum
from functools import partial
from pathlib import Path
from typing import Annotated, Any, Union, get_args, get_origin

from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from fastapi import FastAPI

_current: contextvars.ContextVar[Trace | None] = contextvars.ContextVar(
    "studio_trace", default=None
)
_response_hook_lock = threading.RLock()
_response_hook_state: dict[str, Any] | None = None
_instrumented_codes: dict[int, tuple[Any, Any]] = {}
_source_baseline_lock = threading.RLock()
_source_baselines: dict[Path, dict[str, str]] = {}
_SOURCE_FILE_BYTES = 262144
_SOURCE_TOTAL_BYTES = 40 * 1024 * 1024
_SOURCE_FILES = 5000
_SOURCE_ENTRIES = 40000
_SOURCE_ROOTS = 16
_RESPONSE_FIELDS = 2048
_QUERY_EXECUTIONS = 256
_NO_ENUM_VALUE = object()
_SDK_SOURCE = os.path.normcase(os.path.abspath(__file__))
_OMIT_SOURCE_DIR = re.compile(
    r"^(?:node_modules|vendor|dist|build|out|target|coverage|logs?|data|databases?|"
    r"uploads?|storage|archives?|backups?|tmp|temp|cache|__pycache__|venv|env|"
    r"site-packages|releases?)$", re.I
)
_OMIT_SOURCE_FILE = re.compile(
    r"(?:^|[._-])(?:secrets?|credentials?|private[-_]?keys?|service[-_]?accounts?|"
    r"tokens?|passwords?|sessions?|cookies?)(?:[._-]|$)", re.I
)


def _elapsed_ms(started: float) -> float | None:
    value = (time.perf_counter() - started) * 1000
    return value if math.isfinite(value) and 0 <= value <= 86400000 else None


def _finish_query(query: Any, started: float) -> None:
    elapsed = _elapsed_ms(started)
    if query is not None and elapsed is not None:
        query["durationMs"] = elapsed


def _pooled_header_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Intern repeated metadata without changing any captured evidence.

    Containers are stored in postorder. A child container is represented only
    by ``[index]``, pointing to an earlier object/array entry, so the browser can
    reject forward references and cycles before reconstructing the trace.
    Original arrays are entries too; they cannot be mistaken for references.
    """
    pool: list[Any] = []
    known: dict[str, int] = {}
    active: set[int] = set()
    visits = 0

    def visit(value: Any, depth: int = 0) -> Any:
        nonlocal visits
        visits += 1
        if visits > 50000 or depth > 18:
            raise ValueError("Trace exceeds the compact metadata budget")
        if value is None or type(value) in (str, bool, int):
            return value
        if type(value) is float and math.isfinite(value):
            return value
        if type(value) not in (dict, list, tuple) or id(value) in active:
            raise ValueError("Unsupported compact trace value")
        active.add(id(value))
        try:
            if type(value) is dict:
                if any(type(key) is not str or key in {"__proto__", "constructor", "prototype"}
                       for key in value):
                    raise ValueError("Unsupported compact trace key")
                entry = [0, {key: visit(child, depth + 1) for key, child in value.items()}]
            else:
                entry = [1, [visit(child, depth + 1) for child in value]]
        finally:
            active.remove(id(value))
        key = json.dumps(entry, sort_keys=True, separators=(",", ":"), allow_nan=False)
        index = known.get(key)
        if index is None:
            if len(pool) >= 20000:
                raise ValueError("Too many compact trace containers")
            index = len(pool)
            known[key] = index
            pool.append(entry)
        return [index]

    root = visit(payload)[0]
    return {"encoding": "anvaya-pool-v1", "root": root, "pool": pool}


def _encode_trace_header(payload: dict[str, Any]) -> str | None:
    """Use the legacy format when it fits, then a lossless metadata pool."""
    raw = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
    encoded = base64.b64encode(raw).decode()
    if len(encoded) > 3072:
        encoded = "z1." + base64.b64encode(zlib.compress(raw)).decode()
    # Legacy readers bound the inflated JSON to 300 KB. The pooled format has
    # its own 300 KB wire and 1 MB reconstructed budgets in the browser.
    if len(raw) <= 300000 and len(encoded) <= 6144:
        return encoded
    if len(raw) > 1048576:
        return None
    try:
        # SQLAlchemy uses JSON-compatible str subclasses such as quoted_name
        # for table/column names. Normalize the already-serialized JSON before
        # strict pooling, preserving exactly the legacy transport semantics.
        compact = json.dumps(_pooled_header_payload(json.loads(raw)), separators=(",", ":"),
                             allow_nan=False).encode()
    except (ValueError, TypeError, RecursionError):
        return None
    if len(compact) > 300000:
        return None
    pooled = "z1." + base64.b64encode(zlib.compress(compact)).decode()
    return pooled if len(pooled) <= 6144 else None


def _bounded_trace_header(payload: dict[str, Any]) -> str:
    """Retain useful actual executions when an exceptional trace still overflows.

    Query IDs, statements and their source/model evidence are kept together.
    Response origins survive only when every referenced execution survives;
    this never replaces missing queries with guessed field lineage.
    """
    encoded = _encode_trace_header(payload)
    if encoded is not None:
        return encoded
    reduced = {**payload, "queries": [], "fields": {}, "collections": {}, "truncated": True}
    if _encode_trace_header(reduced) is None:
        reduced.update(route=None, id=payload["id"] if isinstance(payload["id"], str)
                       and len(payload["id"]) <= 80 else None)
    queries = payload["queries"]
    fields = payload["fields"]

    def references(value: Any) -> set[str]:
        found: set[str] = set()
        remaining = [value]
        for _ in range(50000):
            if not remaining:
                break
            item = remaining.pop()
            if type(item) is dict:
                ids = item.get("queries")
                if type(ids) in (list, tuple):
                    found.update(query_id for query_id in ids if isinstance(query_id, str))
                remaining.extend(item.values())
            elif type(item) in (list, tuple):
                remaining.extend(item)
        return found

    origins = [(kind, path, origin, references(origin))
               for kind, values in (("fields", fields), ("collections", payload.get("collections", {})))
               for path, origin in values.items()]
    referenced = {query_id for _, _, _, ids in origins for query_id in ids}
    # Prefer executions that back response fields to incidental/authentication
    # SQL. The retained list still follows its original execution order.
    selected: dict[int, Any] = {}
    priorities = sorted(range(len(queries)), key=lambda index: queries[index].get("id") not in referenced)
    for index in priorities:
        query = queries[index]
        variants = [query]
        if query.get("site") and query.get("frames"):
            variants.append({**query, "frames": []})
        for variant in variants:
            candidates = {**selected, index: variant}
            reduced["queries"] = [candidates[key] for key in sorted(candidates)]
            if _encode_trace_header(reduced) is not None:
                selected = candidates
                break
    reduced["queries"] = [selected[key] for key in sorted(selected)]
    ids = {query.get("id") for query in reduced["queries"]}
    eligible = [(kind, path, origin) for kind, path, origin, required in origins
                if required and required.issubset(ids)]
    lower, upper = 0, len(eligible)
    # Encoding once per field can stall an oversized response. Nine bounded
    # prefix probes plus a final verification cover the ordinary 512-field
    # budget. Compression is not strictly monotonic; a smaller proven prefix
    # is preferable to an unverified or expensive attempt to maximize coverage.
    for _ in range(9):
        if lower >= upper:
            break
        middle = (lower + upper + 1) // 2
        for kind in ("fields", "collections"):
            reduced[kind] = {path: origin for group, path, origin in eligible[:middle] if group == kind}
        if _encode_trace_header(reduced) is not None:
            lower = middle
        else:
            upper = middle - 1
    for kind in ("fields", "collections"):
        reduced[kind] = {path: origin for group, path, origin in eligible[:lower] if group == kind}
    # Even a manual trace with an oversized route has a bounded minimal form.
    return _encode_trace_header(reduced) or _encode_trace_header({
        "id": reduced["id"], "route": None, "queries": [], "fields": {}, "truncated": True
    })


def _linked(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def _source_candidate(root: Path, filename: str | Path) -> tuple[Path, tuple[str, ...]] | None:
    try:
        candidate = Path(filename).absolute()
        parts = candidate.relative_to(root).parts
        if (not parts or candidate.suffix.lower() != ".py"
                or any(part.startswith('.') for part in parts)
                or any(_OMIT_SOURCE_DIR.fullmatch(part) for part in parts[:-1])
                or _OMIT_SOURCE_FILE.search(parts[-1])):
            return None
        return candidate, parts
    except (ValueError, OSError):
        return None


def _source_path(root: Path, filename: str | Path) -> tuple[Path, str] | None:
    """Resolve only ordinary Python sources beneath the registered root."""
    selected = _source_candidate(root, filename)
    if selected is None:
        return None
    candidate, parts = selected
    try:
        current = root
        for part in parts:
            current = current / part
            if _linked(current):
                return None
        full = candidate.resolve()
        relative = full.relative_to(root).as_posix()
        if len(relative) > 512 or not full.is_file() or full.stat().st_size > _SOURCE_FILE_BYTES:
            return None
        return full, relative
    except (ValueError, OSError):
        return None


def _source_hash(full: Path) -> tuple[str, int] | None:
    try:
        # A concurrent file growth cannot turn the size check into an
        # unbounded read. Only hashes, never source bytes, survive this call.
        with full.open("rb") as source:
            raw = source.read(_SOURCE_FILE_BYTES + 1)
        if len(raw) > _SOURCE_FILE_BYTES:
            return None
        return hashlib.sha256(raw).hexdigest(), len(raw)
    except OSError:
        return None


def _source_baseline(root: Path) -> dict[str, str]:
    """Keep the first bounded startup snapshot until this adapter process exits.

    setup()/middleware() register before serving requests. Direct legacy Trace
    construction snapshots lazily on first use, so integrations needing startup
    freshness must register the middleware before accepting development traffic.
    Bounds or unreadable/excluded sources result in absent evidence, never a new
    trusted hash of code edited after startup.
    """
    with _source_baseline_lock:
        if root in _source_baselines:
            return _source_baselines[root]
        if len(_source_baselines) >= _SOURCE_ROOTS:
            return {}
        hashes: dict[str, str] = {}
        entries, total = 0, 0

        def walk(directory: Path, depth: int = 0) -> None:
            nonlocal entries, total
            if depth > 16 or entries >= _SOURCE_ENTRIES or len(hashes) >= _SOURCE_FILES:
                return
            try:
                # Scandir remains bounded even for an unexpectedly huge folder.
                with os.scandir(directory) as iterator:
                    children = []
                    for entry in iterator:
                        if entries >= _SOURCE_ENTRIES:
                            break
                        entries += 1
                        children.append(entry)
                for entry in sorted(children, key=lambda item: item.name):
                    if len(hashes) >= _SOURCE_FILES or total >= _SOURCE_TOTAL_BYTES:
                        break
                    name = entry.name
                    full = Path(entry.path)
                    if name.startswith('.') or _OMIT_SOURCE_FILE.search(name) or _linked(full):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if not _OMIT_SOURCE_DIR.fullmatch(name):
                            walk(full, depth + 1)
                    elif entry.is_file(follow_symlinks=False) and full.suffix.lower() == ".py":
                        safe = _source_path(root, full)
                        if safe is None or safe[0].stat().st_size > _SOURCE_TOTAL_BYTES - total:
                            continue
                        captured = _source_hash(safe[0])
                        if captured is not None and captured[1] <= _SOURCE_TOTAL_BYTES - total:
                            hashes[safe[1]] = captured[0]
                            total += captured[1]
            except OSError:
                return

        walk(root)
        _source_baselines[root] = hashes
        return hashes


class Trace:
    def __init__(self, root: str | Path, request_id: str,
                 *, _sources: dict[str, str] | None = None) -> None:
        self.root = Path(root).resolve()
        self._sources = _source_baseline(self.root) if _sources is None else _sources
        self.id = request_id
        self._started = time.perf_counter()
        self.route: dict[str, Any] | None = None
        self.queries: list[dict[str, Any]] = []
        self.fields: dict[str, Any] = {}
        self.collections: dict[str, Any] = {}
        self._collection_results: dict[int, dict[str, Any]] = {}
        self._collection_lists: dict[int, tuple[Any, dict[str, Any]]] = {}
        self._collection_facts = 0
        self.origins: weakref.WeakKeyDictionary[Any, Any] = weakref.WeakKeyDictionary()
        self._orm_mutations: weakref.WeakKeyDictionary[Any, set[str]] = weakref.WeakKeyDictionary()
        self._model_source_indices: dict[str, dict[str, list[dict[str, Any]]]] = {}
        self._orm_query_tokens: dict[object, tuple[object, dict[str, Any] | None]] = {}
        self._orm_reference_models: dict[object, tuple[Any, ...]] = {}
        self.row_results: dict[int, dict[str, Any]] = {}
        self._orm_loaded_queries: weakref.WeakKeyDictionary[Any, dict[str, Any]] = weakref.WeakKeyDictionary()
        self.dto_origins: dict[int, tuple[Any, dict[str, Any]]] = {}
        # Strong, request-local references prevent an id from being recycled.
        # Application dictionaries remain ordinary built-in dictionaries.
        self.dictionary_origins: dict[int, tuple[dict[str, Any], dict[str, Any]]] = {}
        self._dictionary_keyword_calls: dict[Any, dict[str, Any]] = {}
        self._dto_value_key = os.urandom(32)
        self._dto_field_count = 0
        self._dictionary_field_count = 0
        self._immutable_mutations: set[int] = set()
        self.last_query: dict[str, Any] | None = None
        self.closed = False
        self.truncated = False
        self._payload: dict[str, Any] | None = None
        self._site_sources: dict[str, tuple[Path, str, str] | None] = {}
        self._repository_sources: set[str] = set()
        self._response_model_token: object | None = None

    def site(self, filename: str, line: int, name: str) -> dict[str, Any] | None:
        key = str(filename)
        if key not in self._site_sources:
            if len(self._site_sources) >= 1024:
                self.truncated = True
                return None
            if _source_candidate(self.root, filename) is not None:
                self._repository_sources.add(key)
            safe = _source_path(self.root, filename)
            found = None
            if safe is not None:
                full, relative = safe
                expected = self._sources.get(relative)
                current = _source_hash(full) if expected is not None else None
                if current is not None and current[0] == expected:
                    found = full, relative, expected
            self._site_sources[key] = found
        found = self._site_sources[key]
        if found is None:
            return None
        return dict(path=found[1], line=line, name=name, hash=found[2])

    def _verify_publication_sources(self) -> None:
        # Repeated reads within one request use a verified snapshot. Recheck
        # every attributed file once before publishing, including reparse-point
        # containment, so edits during capture cannot retain stale evidence.
        for filename, found in self._site_sources.items():
            if found is None:
                continue
            safe = _source_path(self.root, filename)
            current = _source_hash(safe[0]) if safe is not None else None
            if (safe is None or safe[0] != found[0] or safe[1] != found[1]
                    or current is None or current[0] != found[2]):
                self.route = None
                self.fields.clear()
                self.collections.clear()
                for query in self.queries:
                    query["site"], query["frames"] = None, []
                    query.pop("models", None)
                return

    def stack(self) -> list[dict[str, Any]]:
        frames: list[dict[str, Any]] = []
        current = inspect.currentframe()
        frame = current.f_back if current else None
        # SQLAlchemy async execution switches into a child greenlet. Its live
        # parent frame is the real suspended caller, not a guessed source site.
        try:
            from greenlet import getcurrent
            parent = getcurrent().parent
        except ImportError:
            parent = None
        try:
            while (frame or parent) and len(frames) < 12:
                if frame is None:
                    frame, parent = parent.gr_frame, parent.parent
                    if frame is None:
                        continue
                if os.path.normcase(os.path.abspath(frame.f_code.co_filename)) != _SDK_SOURCE:
                    site = self.site(frame.f_code.co_filename, frame.f_lineno, frame.f_code.co_name)
                    if site:
                        frames.append(site)
                    else:
                        if (frame.f_code.co_filename in self._repository_sources
                                or frame.f_code.co_filename not in self._site_sources):
                            # Do not replace a changed/unregistered helper
                            # with its still-current caller as the query site.
                            return []
                frame = frame.f_back
        finally:
            del frame
            del parent
        return list(reversed(frames))

    def capture(
        self, statement: str, tables: tuple[str, ...] = (), failed: bool = False
    ) -> dict[str, Any] | None:
        if self.closed:
            return None
        if len(self.queries) >= _QUERY_EXECUTIONS or len(statement) > 6000:
            self.truncated = True
            return None
        sql = re.sub(r"'(?:''|[^'])*'", "'?'", statement)
        sql = re.sub(r"\b\d+(?:\.\d+)?\b", "?", sql)
        frames = self.stack()
        query = dict(
            id=uuid.uuid4().hex,
            sql=sql,
            tables=list(tables)[:20],
            frames=frames,
            site=frames[-1] if frames else None,
            failed=failed,
        )
        self.queries.append(query)
        self.last_query = query
        return query

    def execute(self, cursor: Any, statement: str, parameters: Any = ()) -> Any:
        """Capture an actual DB-API execution; parameter values are never inspected."""
        started = time.perf_counter()
        try:
            result = cursor.execute(statement, parameters)
        except Exception:
            duration = _elapsed_ms(started)
            query = self.capture(statement, failed=True)
            if query is not None:
                offset = (started - self._started) * 1000
                if 0 <= offset <= 86400000:
                    query["startOffsetMs"] = offset
                if duration is not None:
                    query["durationMs"] = duration
            raise
        # Finish before the source stack is captured: instrumentation and optional
        # catalog metadata must not inflate the measured database execution.
        duration = _elapsed_ms(started)
        query = self.capture(statement)
        if query is not None:
            offset = (started - self._started) * 1000
            if 0 <= offset <= 86400000:
                query["startOffsetMs"] = offset
            if duration is not None:
                query["durationMs"] = duration
        return result

    def payload(self) -> dict[str, Any]:
        if self._payload is not None:
            return self._payload
        self.closed = True
        self._verify_publication_sources()
        payload = dict(
            id=self.id,
            route=self.route,
            queries=self.queries,
            fields=self.fields,
            collections=self.collections,
            truncated=self.truncated,
        )
        duration = _elapsed_ms(self._started)
        if duration is not None:
            payload["durationMs"] = duration
        self._payload = payload
        return payload

    def header(self) -> str:
        # Leave room for ordinary application headers and cookies while keeping
        # large repeated ORM/source metadata losslessly when it can be pooled.
        return _bounded_trace_header(self.payload())


def attach_sqlalchemy(engine: Any) -> Callable[[], None]:
    """Observe actual engine executions only inside a Studio development trace."""
    from sqlalchemy import event

    # AsyncEngine exposes the synchronous event target used by SQLAlchemy.
    engine = getattr(engine, "sync_engine", engine)

    def before(
        conn: Any, cursor: Any, statement: str, parameters: Any, context: Any, executemany: bool
    ) -> None:
        trace = _current.get()
        if trace and not trace.closed:
            try:
                context._studio_query = trace.capture(statement)
                token = context.execution_options.get("_studio_orm_load")
                if type(token) is object and token in trace._orm_query_tokens:
                    observer, _ = trace._orm_query_tokens[token]
                    trace._orm_query_tokens[token] = (observer, context._studio_query)
                context._studio_started = time.perf_counter()
                if context._studio_query is not None:
                    offset = (context._studio_started - trace._started) * 1000
                    if 0 <= offset <= 86400000:
                        context._studio_query["startOffsetMs"] = offset
            except Exception:
                context._studio_query = None

    def after(
        conn: Any, cursor: Any, statement: str, parameters: Any, context: Any, executemany: bool
    ) -> None:
        trace = _current.get()
        query = getattr(context, "_studio_query", None)
        if trace and query:
            _finish_query(query, context._studio_started)
            try:
                from sqlalchemy.sql.schema import Table
                from sqlalchemy.sql.visitors import iterate

                query["tables"] = sorted(
                    {
                        node.fullname
                        for node in iterate(context.compiled.statement)
                        if isinstance(node, Table)
                    }
                )[:20]
                from sqlalchemy.sql.schema import Column

                query["columns"] = sorted(
                    {
                        f"{column.table.fullname}.{column.name}"
                        for entry in context.compiled._result_columns
                        for column in entry.objects
                        if isinstance(column, Column)
                    }
                )
            except Exception:
                pass  # Optional capture must never fail an application query.
            token = context.execution_options.get("_studio_orm_load")
            if type(token) is object:
                for mapper in trace._orm_reference_models.get(token, ()):
                    _query_model_evidence(trace, query, mapper, reference=True)

    def error(context: Any) -> None:
        query = getattr(context.execution_context, "_studio_query", None)
        if query:
            _finish_query(query, context.execution_context._studio_started)
            query["failed"] = True

    event.listen(engine, "before_cursor_execute", before)
    event.listen(engine, "after_cursor_execute", after)
    event.listen(engine, "handle_error", error)

    def detach() -> None:
        event.remove(engine, "before_cursor_execute", before)
        event.remove(engine, "after_cursor_execute", after)
        event.remove(engine, "handle_error", error)

    return detach


def middleware(app: FastAPI, root: str | Path, *, development: bool = False,
               exclude: tuple[str, ...] = ("/auth", "/api/auth", "/api/v1/auth"),
               _response_model_token: object | None = None,
               publish_trace: Callable[[dict[str, Any]], str | None] | None = None) -> None:
    """Install explicitly in a development FastAPI app. Disabled unless opted in."""
    from starlette.middleware.base import BaseHTTPMiddleware

    registered_root = Path(root).resolve()
    sources = _source_baseline(registered_root) if development else {}

    async def dispatch(request: Any, call_next: Any) -> Any:
        request_id = request.headers.get("x-studio-trace", "")
        if request.url.hostname not in {
            "localhost",
            "127.0.0.1",
            "::1",
            "testserver",
        } or any(request.url.path == prefix or request.url.path.startswith(prefix + "/") for prefix in exclude):
            return await call_next(request)
        if not development or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", request_id):
            return await call_next(request)
        trace = Trace(registered_root, request_id, _sources=sources)
        trace._response_model_token = _response_model_token
        token = _current.set(trace)
        try:
            response = await call_next(request)
            endpoint = request.scope.get("endpoint")
            if inspect.isfunction(endpoint):
                trace.route = trace.site(
                    endpoint.__code__.co_filename,
                    endpoint.__code__.co_firstlineno,
                    endpoint.__name__,
                )
            if trace.route is None:
                # ORM metadata alone cannot certify a response executed by an
                # edited/unregistered endpoint, even when another query helper
                # still has a current source site.
                trace.fields.clear()
            try:
                payload = trace.payload()
                # Large managed captures go straight to the bounded host store.
                # Pooling hundreds of repeated origins on the ASGI event loop
                # delays unrelated application requests during startup bursts.
                attempted = publish_trace is not None and (
                    len(payload["queries"]) > 20 or len(payload["fields"]) > 128)
                key = None
                if attempted:
                    try:
                        key = publish_trace(payload)
                    except Exception:
                        pass
                valid = isinstance(key, str) and re.fullmatch(r"[0-9a-f]{32}", key)
                complete = None if valid else _encode_trace_header(payload)
                if complete is not None:
                    response.headers["Studio-Trace"] = complete
                else:
                    if not attempted:
                        try:
                            key = publish_trace(payload) if publish_trace is not None else None
                        except Exception:
                            key = None
                    if isinstance(key, str) and re.fullmatch(r"[0-9a-f]{32}", key):
                        reference = {"id": trace.id, "ref": "anvaya-managed-v1", "key": key}
                        response.headers["Studio-Trace"] = base64.b64encode(
                            json.dumps(reference, separators=(",", ":")).encode()).decode()
                    else:
                        response.headers["Studio-Trace"] = _bounded_trace_header(payload)
            except Exception:
                pass  # Optional capture cannot change a successful response.
            return response
        finally:
            _current.reset(token)

    app.add_middleware(BaseHTTPMiddleware, dispatch=dispatch)


@contextmanager
def capture(trace: Trace) -> Iterator[Trace]:
    """For other development servers and test harnesses."""
    token = _current.set(trace)
    try:
        yield trace
    finally:
        _current.reset(token)


def attach_orm(factory: Any) -> Callable[[], None]:
    from sqlalchemy import event
    from sqlalchemy import inspect as orm_inspect
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
    from sqlalchemy.orm import Mapper

    if isinstance(factory, async_sessionmaker):
        factory = factory.class_.sync_session_class
    elif isinstance(factory, AsyncSession):
        factory = factory.sync_session
    elif isinstance(factory, type) and issubclass(factory, AsyncSession):
        factory = factory.sync_session_class

    watched: dict[Any, Callable[..., None]] = {}
    watch_lock = threading.RLock()
    observer = object()

    def executing(state: Any) -> Any:
        trace = _current.get()
        if trace and not trace.closed and len(trace._orm_query_tokens) < _QUERY_EXECUTIONS:
            # The token travels through the actual cursor execution and ORM
            # load context. Delayed/interleaved result consumption must not
            # attach a class to whichever query happened to execute last.
            token = object()
            trace._orm_query_tokens[token] = (observer, None)
            try:
                if state.is_select and state.is_orm_statement:
                    # Public runtime mapper associations, including scalar
                    # select(Model.column), never table-name inference.
                    trace._orm_reference_models[token] = tuple(state.all_mappers)[:12]
            except Exception:
                pass
            state.update_execution_options(_studio_orm_load=token)
            # SQLAlchemy's supported execution hook returns the original
            # Result unchanged. No rows are consumed or replaced here.
            result = state.invoke_statement()
            try:
                _register_collection_result(trace, result, token, observer)
            except Exception:
                pass
            try:
                _register_row_result(trace, result, token, observer)
            except Exception:
                pass
            return result
        elif trace and not trace.closed:
            trace.truncated = True

    def model_loaded(instance: Any, context: Any) -> None:
        trace = _current.get()
        if not trace or trace.closed or context is None:
            return
        try:
            token = context.execution_options.get("_studio_orm_load")
            if type(token) is not object:
                return
            registration, query = trace._orm_query_tokens.get(token, (None, None))
            if registration is observer and query is not None:
                state = orm_inspect(instance)
                trace._orm_loaded_queries[state] = query
                _query_model_evidence(trace, query, state.mapper)
        except Exception:
            pass  # Class evidence must never change application ORM loading.

    def watch(mapper: Any) -> bool:
        with watch_lock:
            for column in mapper.column_attrs:
                attribute = column.class_attribute
                if attribute in watched:
                    continue
                if len(watched) >= 2000:
                    return False

                def assigned(instance: Any, value: Any, old: Any, initiator: Any,
                             key: str = column.key) -> None:
                    try:
                        trace = _current.get()
                        state = orm_inspect(instance)
                        if trace and not trace.closed and state in trace.origins:
                            trace._orm_mutations.setdefault(state, set()).add(key)
                    except Exception:
                        pass  # Optional write observation must preserve assignment.

                # No retval/active_history: observe a write without altering its
                # value or triggering another database read. Same-value writes
                # remain invalid even after flush clears SQLAlchemy's history.
                event.listen(attribute, "set", assigned)
                watched[attribute] = assigned
        return True

    def loaded(session: Any, instance: Any) -> None:
        trace = _current.get()
        if trace and not trace.closed:
            try:
                state = orm_inspect(instance)
                query = trace._orm_loaded_queries.pop(state, None)
                if query is None:
                    return
                if not watch(state.mapper):
                    return
                # Only newly loaded instances, never reused identity-map values.
                values = {column.key: _dto_fingerprint(trace, state.attrs[column.key].loaded_value)
                          for column in state.mapper.column_attrs}
                trace.origins[state] = (query["id"], state.mapper, values)
            except Exception:
                pass

    event.listen(factory, "do_orm_execute", executing)
    event.listen(Mapper, "load", model_loaded, restore_load_context=True)
    event.listen(factory, "loaded_as_persistent", loaded)
    def detach() -> None:
        event.remove(factory, "do_orm_execute", executing)
        event.remove(Mapper, "load", model_loaded)
        event.remove(factory, "loaded_as_persistent", loaded)
        with watch_lock:
            for attribute, callback in watched.items():
                event.remove(attribute, "set", callback)
            watched.clear()
    return detach


def _declared_column_name(module: types.ModuleType, statement: ast.AST,
                          attribute: str) -> str | None:
    """Recognize ordinary SQLAlchemy declarations without executing source."""
    from sqlalchemy import Column
    from sqlalchemy.orm import Mapped, mapped_column

    def reference(node: ast.AST) -> Any:
        if isinstance(node, ast.Name):
            return vars(module).get(node.id)
        if isinstance(node, ast.Attribute):
            parent = reference(node.value)
            if type(parent) is types.ModuleType:
                return vars(parent).get(node.attr)
        return None

    value = getattr(statement, "value", None)
    if value is None and isinstance(statement, ast.AnnAssign):
        annotation = statement.annotation
        if isinstance(annotation, ast.Subscript) and reference(annotation.value) is Mapped:
            return attribute
        return
    if not isinstance(value, ast.Call):
        return
    constructor = reference(value.func)
    if constructor is not Column and constructor is not mapped_column:
        return
    names = [keyword.value for keyword in value.keywords if keyword.arg == "name"]
    if len(names) > 1:
        return
    if names:
        return names[0].value if isinstance(names[0], ast.Constant) and type(names[0].value) is str else None
    if value.args and isinstance(value.args[0], ast.Constant) and type(value.args[0].value) is str:
        return value.args[0].value
    # Dynamic name expansion cannot identify a declaration confidently.
    if any(keyword.arg is None for keyword in value.keywords) or any(isinstance(arg, ast.Starred) for arg in value.args):
        return
    return attribute


def _model_declaration(trace: Trace, model: type) -> dict[str, Any] | None:
    """Locate an actual mapped class in a bounded, still-current source snapshot.

    Class names alone are insufficient: lexical qualnames distinguish nested
    declarations, and repeated declarations of one qualname remain ambiguous.
    No source expression is imported or evaluated to resolve a model.
    """
    try:
        module = sys.modules.get(type.__getattribute__(model, "__module__"))
        if type(module) is not types.ModuleType:
            return
        filename = vars(module).get("__file__")
        if not isinstance(filename, str):
            return
        name = type.__getattribute__(model, "__name__")
        qualname = type.__getattribute__(model, "__qualname__")
        if (not isinstance(name, str) or not isinstance(qualname, str)
                or len(qualname) > 512):
            return
        site = trace.site(filename, 1, name)
        if site is None:
            return
        key = site["path"]
        index = trace._model_source_indices.get(key)
        if index is None:
            if len(trace._model_source_indices) >= 32:
                return
            safe = _source_path(trace.root, filename)
            if safe is None:
                return
            with safe[0].open("rb") as source:
                raw = source.read(_SOURCE_FILE_BYTES + 1)
            if (len(raw) > _SOURCE_FILE_BYTES
                    or hashlib.sha256(raw).hexdigest() != site["hash"]):
                return
            tree = ast.parse(raw, filename=filename)
            index = {}
            rebound: set[str] = set()
            mutated: set[str] = set()
            pending: list[tuple[ast.AST, str]] = [(tree, "")]
            visited = 0
            while pending:
                node, prefix = pending.pop()
                visited += 1
                if visited > 20000 or len(prefix) > 512:
                    return
                if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    for target in targets:
                        for leaf in ast.walk(target):
                            if isinstance(leaf, ast.Name) and isinstance(leaf.ctx, ast.Store):
                                rebound.add(prefix + leaf.id)
                        if isinstance(target, ast.Attribute):
                            parts = []
                            value = target
                            while isinstance(value, ast.Attribute):
                                parts.append(value.attr)
                                value = value.value
                            if isinstance(value, ast.Name):
                                parts.append(value.id)
                                path = ".".join(reversed(parts))
                                mutated.update((prefix + path, path))
                elif isinstance(node, (ast.Import, ast.ImportFrom)):
                    rebound.update(prefix + (alias.asname or alias.name.split('.')[0])
                                   for alias in node.names)
                if isinstance(node, ast.ClassDef):
                    fields: dict[str, int | None] = {}
                    columns: dict[str, str] = {}

                    def binding(statement: ast.AST, direct: bool) -> None:
                        # Any lexical override blocks inherited declarations.
                        # Methods/declared_attr and conditional assignments do
                        # not fall through to a similarly named mixin field.
                        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                            fields[statement.name] = None
                            columns.pop(statement.name, None)
                            return
                        targets = (statement.targets if isinstance(statement, ast.Assign)
                                   else [statement.target] if isinstance(statement, ast.AnnAssign)
                                   else [statement.target] if isinstance(statement, ast.AugAssign)
                                   else [])
                        for target in targets:
                            for leaf in ast.walk(target):
                                if isinstance(leaf, ast.Name):
                                    declared = (_declared_column_name(module, statement, leaf.id)
                                                if direct and isinstance(target, ast.Name) else None)
                                    unique = leaf.id not in fields and declared is not None
                                    fields[leaf.id] = statement.lineno if unique else None
                                    if unique:
                                        columns[leaf.id] = declared
                                    else:
                                        columns.pop(leaf.id, None)
                        if not targets:
                            for child in ast.iter_child_nodes(statement):
                                binding(child, False)

                    for statement in node.body:
                        binding(statement, True)
                    declaration = dict(name=node.name, line=node.lineno, fields=fields, columns=columns)
                    index.setdefault(prefix + node.name, []).append(declaration)
                    prefix += node.name + "."
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    rebound.add(prefix + node.name)
                    prefix += node.name + ".<locals>."
                pending.extend((child, prefix) for child in ast.iter_child_nodes(node))
            for qualified in rebound:
                index.pop(qualified, None)
            for qualified, declarations in index.items():
                for declaration in declarations:
                    for field in declaration["fields"]:
                        if qualified + "." + field in mutated:
                            declaration["fields"][field] = None
                            declaration["columns"].pop(field, None)
            trace._model_source_indices[key] = index
        candidates = index.get(qualname, [])
        if len(candidates) != 1 or candidates[0]["name"] != name:
            return
        declaration = candidates[0]
        current = trace.site(filename, declaration["line"], name)
        if current is None or current["hash"] != site["hash"]:
            return
        return dict(site=current, fields=declaration["fields"], columns=declaration["columns"])
    except (OSError, ValueError, SyntaxError, TypeError, AttributeError, RecursionError):
        return


def _query_model_evidence(trace: Trace, query: dict[str, Any], mapper: Any, *, reference: bool = False) -> None:
    """Record actual ORM class use; distinguish a reference from an instance load."""
    try:
        from sqlalchemy.sql.schema import Table

        if (query.get("failed") or not (query.get("site") or query.get("frames"))
                or not any(query is captured for captured in trace.queries)):
            return
        models = query.get("models", [])
        declaration = _model_declaration(trace, mapper.class_)
        if declaration is None:
            return
        site = declaration["site"]
        for item in models:
            if item["modelSource"] == site:
                if not reference:
                    item.pop("evidence", None)  # A real Mapper.load upgrades the weaker reference.
                return
        if len(models) >= 12:
            return
        model = site["name"]
        if not model or len(model) > 200:
            return
        evidence = {"model": model, "modelSource": dict(site)}
        if reference:
            evidence["evidence"] = "query-reference"
        table = mapper.local_table
        if isinstance(table, Table) and table.fullname in query.get("tables", []):
            evidence["table"] = table.fullname
        query.setdefault("models", []).append(evidence)
    except Exception:
        pass  # A missing definition cannot invalidate executed SQL or values.


def _orm_model_evidence(trace: Trace, mapper: Any, attribute: str,
                        column: Any) -> dict[str, Any]:
    """Optional declaration evidence never replaces executed-column proof."""
    evidence: dict[str, Any] = {"attribute": attribute}
    try:
        # Type names are metadata only. Calling str(column.type), python_type or
        # a custom type's formatter could run application code during capture.
        type_name = type.__getattribute__(type(column.type), "__name__")
        if isinstance(type_name, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", type_name):
            evidence["type"] = type_name
        if type(column.nullable) is bool:
            evidence["nullable"] = column.nullable
        model = mapper.class_
        declaration = _model_declaration(trace, model)
        if declaration is not None:
            evidence["modelSource"] = declaration["site"]
        # Single-table inheritance and declarative mixins may put the field on
        # a base class. Only a direct, unique source assignment is highlighted;
        # dynamically added/injected columns retain their proven DB origin.
        for owner in type.__getattribute__(model, "__mro__")[:32]:
            owner_declaration = declaration if owner is model else _model_declaration(trace, owner)
            if owner_declaration is not None and attribute in owner_declaration["fields"]:
                line = owner_declaration["fields"][attribute]
                if (line is not None
                        and owner_declaration["columns"].get(attribute) == column.name):
                    evidence["fieldSource"] = {**owner_declaration["site"],
                                               "line": line, "name": attribute}
                break
    except Exception:
        pass  # Optional model introspection must not invalidate a direct origin.
    return evidence


def _orm_origin(trace: Trace, instance: Any, attribute: str) -> dict[str, Any] | None:
    try:
        from sqlalchemy import inspect as orm_inspect
        from sqlalchemy.orm.attributes import NO_VALUE

        state = orm_inspect(instance)
        query_id, mapper, snapshots = trace.origins[state]
        attr = state.attrs[attribute]
        if (attr.loaded_value is NO_VALUE or attr.history.has_changes()
                or attribute in trace._orm_mutations.get(state, set())
                or snapshots.get(attribute) is None
                or _dto_fingerprint(trace, attr.loaded_value) != snapshots.get(attribute)):
            return
        columns = mapper.column_attrs[attribute].columns
        if len(columns) != 1:
            return
        column = columns[0]
        query = next(q for q in trace.queries if q["id"] == query_id)
        if query.get("failed") or (not query.get("site") and not query.get("frames")):
            return
        if f"{column.table.fullname}.{column.name}" not in query.get("columns", []):
            return
        return dict(
            table=column.table.fullname,
            column=column.name,
            model=mapper.class_.__name__,
            queries=[query_id],
            **_orm_model_evidence(trace, mapper, attribute, column),
        )
    except Exception:
        return  # Unsupported ORM metadata cannot change serialization.


def response_field(path: str, instance: Any, attribute: str) -> None:
    """Publish origin only for a loaded, unmodified ORM attribute in this request."""
    trace = _current.get()
    if (not trace or trace.closed or not isinstance(path, str) or len(path) > 200
            or any(part in {"__proto__", "constructor", "prototype"} for part in path.split('.'))
            or len(trace.fields) >= _RESPONSE_FIELDS):
        return
    origin = _orm_origin(trace, instance, attribute)
    if origin is not None:
        trace.fields[path] = origin


def _register_collection_result(trace: Trace, result: Any, token: object, observer: object) -> None:
    """Remember a native, unconsumed execution without fetching any rows."""
    from sqlalchemy.engine import CursorResult
    from sqlalchemy.engine.result import ChunkedIteratorResult, IteratorResult
    from sqlalchemy.orm import loading
    if len(trace._collection_results) >= 256 or type(result) not in (CursorResult, ChunkedIteratorResult):
        return
    raw = result if type(result) is CursorResult else result.raw
    registration, query = trace._orm_query_tokens.get(token, (None, None))
    if (type(raw) is not CursorResult or raw.closed or registration is not observer or query is None
            or raw.context._studio_query is not query or raw.context.execution_options.get("_studio_orm_load") is not token
            or query.get("failed") or not (query.get("site") or query.get("frames"))):
        return
    if not _native_row_getter(raw) or not all(_row_processor_supported(value) for value in raw._metadata._processors or ()):
        return
    if type(result) is ChunkedIteratorResult:
        chunks = result.chunks
        if (type(chunks) is not types.FunctionType or chunks.__globals__ is not vars(loading)
                or not any(chunks.__code__ is code for code in loading.instances.__code__.co_consts
                           if type(code) is types.CodeType and code.co_name == "chunks")
                or type(result.iterator) is not itertools.chain
                or result._fetchall_impl.__func__ is not IteratorResult._fetchall_impl
                or result._soft_close.__func__ is not ChunkedIteratorResult._soft_close):
            return
        cells = dict(zip(chunks.__code__.co_freevars, chunks.__closure__ or ()))
        if "cursor" not in cells or cells["cursor"].cell_contents is not raw:
            return
        references = [value for value in gc.get_referents(result.iterator) if value is not itertools.chain]
        if (len(references) != 1 or type(references[0]) is not types.GeneratorType
                or references[0].gi_code is not chunks.__code__
                or inspect.getgeneratorstate(references[0]) != inspect.GEN_CREATED
                or references[0].gi_frame.f_locals.get("cursor") is not raw
                or references[0].gi_frame.f_locals.get("context") is not cells["context"].cell_contents):
            return
    trace._collection_results[id(result)] = dict(result=result, raw=raw, query=query, valid=True, consumed=False,
        iterator=getattr(result, "iterator", None), chunks=getattr(result, "chunks", None),
        metadata=result._metadata, raw_metadata=raw._metadata,
        processors=tuple((metadata, metadata._processors, tuple(metadata._processors or ()))
                         for metadata in (raw._metadata, result._metadata)))


def _collection_result_valid(record: Any, owner: Any, *, after: bool = False) -> bool:
    from sqlalchemy.engine import CursorResult
    from sqlalchemy.engine.result import ChunkedIteratorResult, ScalarResult, IteratorResult, ResultInternal
    real, raw = record["result"], record["raw"]
    if (not record["valid"] or record["query"].get("failed") or real._metadata is not record["metadata"]
            or raw._metadata is not record["raw_metadata"] or raw.context._studio_query is not record["query"]
            or real._unique_filter_state is not None or real._post_creational_filter is not None
            or owner._allrows.__func__ is not ResultInternal._allrows
            or raw._fetchall_impl.__func__ is not CursorResult._fetchall_impl):
        return False
    if type(real) is ChunkedIteratorResult and (
            not after and real.chunks is not record["chunks"] or not after and real.iterator is not record["iterator"]
            or real._fetchall_impl.__func__ is not IteratorResult._fetchall_impl
            or real._soft_close.__func__ is not ChunkedIteratorResult._soft_close):
        return False
    if type(owner) is ScalarResult:
        if (owner._real_result is not real or not real._source_supports_scalars
                or owner._unique_filter_state is not None or owner._post_creational_filter is not None
                or owner._row_getter is not None or owner._fetchall_impl.__func__ is not ScalarResult._fetchall_impl):
            return False
    elif owner is not real or not _collection_row_getter(real):
        return False
    if not _native_row_getter(raw):
        return False
    for metadata, vector, entries in record["processors"]:
        current = metadata._processors
        if current is not vector or current is not None and (
                len(current) != len(entries) or any(left is not right for left, right in zip(current, entries))):
            return False
    return True


def _collection_row_getter(result: Any) -> bool:
    from sqlalchemy.engine import Row
    from sqlalchemy.engine import result as native
    getter, metadata = result._row_getter, result._metadata
    if type(getter) is not partial or len(getter.args) != 3 or getter.keywords:
        return False
    function = getter.func
    native_function = (function is Row or type(function) is types.FunctionType
        and function.__globals__ is vars(native)
        and any(function.__code__ is code for code in native.ResultInternal._row_getter.fget.__code__.co_consts
                if type(code) is types.CodeType and code.co_name == "process_row")
        and function.__code__.co_freevars == ("_proc",)
        and function.__closure__[0].cell_contents is Row)
    return bool(native_function and getter.args[0] is metadata and getter.args[1] is metadata._effective_processors
                and getter.args[2] is metadata._key_to_index and metadata._tuplefilter is None)


def _collection_all_call(trace: Trace, function: Any, args: Any, kwargs: Any) -> Any:
    from sqlalchemy.engine.result import Result, ScalarResult
    if args or kwargs or type(function) is not types.MethodType or not any(
            function.__func__ is method for method in (Result.all, ScalarResult.all)):
        return None
    owner = function.__self__
    real = owner._real_result if type(owner) is ScalarResult else owner
    record = trace._collection_results.get(id(real))
    if (not record or record["result"] is not real or record["consumed"]
            or not _collection_result_valid(record, owner)):
        return None
    return owner, record


def _collection_record(trace: Trace, value: Any, queries: Any, site: Any) -> None:
    if type(value) is not list or site is None or trace.closed:
        return
    if (len(trace._collection_lists) >= 256 or len(value) > _RESPONSE_FIELDS
            or trace._collection_facts + len(value) > _RESPONSE_FIELDS):
        trace.truncated = True
        return
    trace._collection_facts += len(value)
    trace._collection_lists[id(value)] = (value, dict(queries=tuple(queries), source=site,
                                                    snapshot=tuple(id(item) for item in value), valid=True))


def _collection_entry(trace: Trace, value: Any) -> Any:
    entry = trace._collection_lists.get(id(value)) if type(value) is list else None
    if (entry and entry[0] is value and entry[1]["valid"] and len(value) == len(entry[1]["snapshot"])
            and all(id(item) == expected for item, expected in zip(value, entry[1]["snapshot"]))):
        return entry[1]
    return None


def _collection_invalidate(value: Any) -> None:
    trace = _current.get()
    entry = trace._collection_lists.get(id(value)) if trace and not trace.closed else None
    if entry and entry[0] is value:
        entry[1]["valid"] = False


def _collection_slice(registration: Any, source: Any, lower: Any, upper: Any, step: Any,
                      filename: str, line: int) -> Any:
    result = source[slice(lower, upper, step)]
    trace = _current.get()
    if (registration.active and trace and not trace.closed and type(source) is list
            and all(value is None or type(value) is int for value in (lower, upper, step))):
        entry = _collection_entry(trace, source)
        if entry:
            _collection_record(trace, result, entry["queries"], trace.site(filename, line, "slice"))
    return result


def _collection_iteration(builder: Any, source: Any) -> Iterator[Any]:
    trace = _current.get()
    entry = _collection_entry(trace, source) if trace and not trace.closed else None
    builder.update(source=source, entry=entry, count=0)
    for value in source:
        builder["count"] += 1
        yield value


def _collection_comprehension(registration: Any, make: Any, filename: str, line: int) -> Any:
    builder = {}
    result = make(builder)
    trace, entry = _current.get(), builder.get("entry")
    if (registration.active and trace and not trace.closed and entry
            and _collection_entry(trace, builder["source"]) is entry
            and type(result) is list and len(result) == builder["count"] == len(entry["snapshot"])):
        _collection_record(trace, result, entry["queries"], trace.site(filename, line, "list comprehension"))
    return result


def _publish_collection(trace: Trace, source: Any, encoded: Any, path: str) -> None:
    entry = _collection_entry(trace, source)
    if not entry or type(encoded) is not list or len(source) != len(encoded) or len(trace.collections) >= 256:
        return
    site = entry["source"]
    if trace.site(str(trace.root / site["path"]), site["line"], site["name"]) == site:
        trace.collections[path] = dict(queries=list(entry["queries"]), count=len(encoded), source=site)


def _row_processor_supported(processor: Any) -> bool:
    if processor is None:
        return True
    # Only the exact native UUID converter is needed for dictionary keys.
    # A callback's module/name can be spoofed and is not execution evidence.
    from sqlalchemy.sql import sqltypes
    method = sqltypes.Uuid.result_processor
    return (type(method) is types.FunctionType and type(processor) is types.FunctionType
            and processor.__globals__ is vars(sqltypes) and processor.__closure__ is None
            and processor.__defaults__ is None and processor.__kwdefaults__ is None
            and processor.__globals__.get("_python_UUID") is uuid.UUID
            and processor.__globals__.get("str", str) is str
            and any(processor.__code__ is code for code in method.__code__.co_consts
                    if type(code) is types.CodeType))


def _row_record_valid(record: Any, result: Any) -> bool:
    if (not record["valid"] or record["result"]() is not result
            or record["metadata"] is not result._metadata or record["getter"] is not result._row_getter
            or record["raw"] is not (result if record["raw"] is result else result.raw)):
        return False
    raw = record["raw"]
    if (raw is None or raw.context is not record["context"] or raw._metadata is not record["raw_metadata"]
            or raw._row_getter is not record["raw_getter"]):
        return False
    if not _native_row_getter(result) or not _native_row_getter(raw):
        return False
    for metadata, vector, entries in record["processors"]:
        current = metadata._processors
        if current is not vector or current is not None and (
                len(current) != len(entries) or any(left is not right for left, right in zip(current, entries))):
            return False
    return True


def _native_row_getter(result: Any) -> bool:
    from sqlalchemy.engine import Row
    getter, metadata = result._row_getter, result._metadata
    return (type(getter) is partial and getter.func is Row and not getter.keywords
            and len(getter.args) == 3 and getter.args[0] is metadata
            and getter.args[1] is metadata._effective_processors
            and getter.args[2] is metadata._key_to_index and metadata._tuplefilter is None)


def _register_row_result(trace: Trace, result: Any, token: object, observer: object) -> None:
    """Associate native scalar rows with their successful execution, not values."""
    from sqlalchemy.engine import CursorResult, Row
    from sqlalchemy.engine.result import ChunkedIteratorResult
    from sqlalchemy.sql.schema import Column, Table
    from sqlalchemy.sql.annotation import AnnotatedColumn
    from sqlalchemy.sql import sqltypes

    if len(trace.row_results) >= _QUERY_EXECUTIONS or type(result) not in (CursorResult, ChunkedIteratorResult):
        return
    raw = result if type(result) is CursorResult else result.raw
    if type(raw) is not CursorResult or raw.closed:
        return
    context = raw.context
    registration, query = trace._orm_query_tokens.get(token, (None, None))
    if (registration is not observer or query is None or context._studio_query is not query
            or context.execution_options.get("_studio_orm_load") is not token
            or query.get("failed") or not (query.get("site") or query.get("frames"))
            or not any(query is captured for captured in trace.queries)):
        return
    entries = tuple(context.compiled._result_columns)
    keys = tuple(result.keys())
    if not entries or len(entries) != len(keys) or len(entries) > 12 or len(set(keys)) != len(keys):
        return  # Entity results and ambiguous result labels are not scalar rows.
    selected = tuple(context.compiled.statement.selected_columns)
    if len(selected) != len(entries):
        return
    processors = raw._metadata._processors
    if processors is None:
        processors = [None] * len(entries)
    if len(processors) != len(entries):
        return
    if not all(_row_processor_supported(processor) for processor in processors):
        return  # Any custom processor could modify another output slot.
    supported_types = (sqltypes.String, sqltypes.Text, sqltypes.Unicode, sqltypes.UnicodeText,
                       sqltypes.Integer, sqltypes.SmallInteger, sqltypes.BigInteger, sqltypes.Boolean,
                       sqltypes.Float, sqltypes.Double, sqltypes.Uuid, sqltypes.UUID,
                       sqltypes.Date, sqltypes.DateTime, sqltypes.Time, sqltypes.Numeric)
    candidates = [entry.objects[0] if entry.objects and type(entry.objects[0]) is Column else None
                  for entry in entries]
    selected_physical = [column if type(column) is Column else column._deannotate()
                         if type(column) is AnnotatedColumn else None for column in selected]
    counts = {id(column): sum(other is column for other in selected_physical)
              for column in candidates if column is not None}
    origins = []
    for index, column in enumerate(candidates):
        origin = None
        direct = (selected[index] is column or type(selected[index]) is AnnotatedColumn
                  and selected[index]._deannotate() is column)
        if (column is not None and direct and counts[id(column)] == 1
                and type(column.table) is Table and type(column.type) in supported_types
                and not getattr(column.type, "_variant_mapping", None)
                and _row_processor_supported(processors[index])
                and f"{column.table.fullname}.{column.name}" in query.get("columns", [])):
            owners = [(mapper, property.key) for mapper in trace._orm_reference_models.get(token, ())
                      for property in mapper.column_attrs
                      if len(property.columns) == 1 and property.columns[0] is column]
            if len(owners) == 1:
                mapper, attribute = owners[0]
                origin = dict(table=column.table.fullname, column=column.name,
                              model=type.__getattribute__(mapper.class_, "__name__"), queries=[query["id"]],
                              **_orm_model_evidence(trace, mapper, attribute, column))
        origins.append(origin)
    if not any(origins):
        return
    getter = result._row_getter
    if (not _native_row_getter(result) or not _native_row_getter(raw)
            or type(inspect.getattr_static(Row, "__iter__")) is not types.WrapperDescriptorType):
        return
    trace.row_results[id(result)] = dict(result=weakref.ref(result), query=query,
                                        metadata=result._metadata, getter=getter,
                                        raw=raw, context=context, raw_metadata=raw._metadata, raw_getter=raw._row_getter,
                                        processors=tuple((metadata, metadata._processors,
                                                          tuple(metadata._processors or ()))
                                                         for metadata in (raw._metadata, result._metadata)),
                                        origins=tuple(origins), valid=True)


def _row_iteration(builder: Any, result: Any, names: tuple[str, ...]) -> Iterator[Any]:
    """Yield the same native Rows; the application performs its own unpacking."""
    from sqlalchemy.engine import Row
    trace = _current.get()
    record = trace.row_results.get(id(result)) if trace and not trace.closed else None
    valid = bool(record and len(record["origins"]) == len(names) and _row_record_valid(record, result))
    iterator = iter(result)
    while True:
        builder.pop("row", None)
        if valid and not _row_record_valid(record, result):
            valid = False
        try:
            row = next(iterator)
        except StopIteration:
            break
        if valid and not _row_record_valid(record, result):
            valid = False
        if (valid and type(row) is Row and row._parent is record["metadata"]
                and type(row._data) is tuple and len(row._data) == len(names)):
            builder["row"] = (row, record, names, tuple(_dto_fingerprint(trace, value) for value in row._data))
        yield row
    builder.pop("row", None)


def _row_pair(builder: Any, name: str, value: Any) -> tuple[Any, Any]:
    trace = _current.get()
    row = builder.get("row")
    if not trace or trace.closed or not row:
        return value, None
    original, record, names, snapshots = row
    if name not in names or not record["valid"]:
        return value, None
    index = names.index(name)
    if (value is not original._data[index] or snapshots[index] is None
            or _dto_fingerprint(trace, value) != snapshots[index]):
        return value, None
    return value, record["origins"][index]


def _row_choose(left: Any, otherwise: Any) -> Any:
    return left if left[0] else otherwise()


def _safe_response_schema(schema: Any, depth: int = 0, *, allow_computed: bool = False) -> bool:
    """Reject user-defined validation/serialization before claiming direct values."""
    if depth > 40:
        return False
    if isinstance(schema, (list, tuple)):
        return all(_safe_response_schema(item, depth + 1, allow_computed=allow_computed) for item in schema)
    if not isinstance(schema, dict):
        return True
    kind = schema.get("type", "")
    if kind == "computed-field" and allow_computed:
        return True  # The walker visits declared fields only, never this getter.
    if (isinstance(kind, str) and kind.startswith("function-")) or kind == "computed-field":
        return False
    standard_sqlmodel_init = False
    if schema.get("custom_init") and kind == "model":
        try:
            from sqlmodel import SQLModel
            cls = schema.get("cls")
            standard_sqlmodel_init = (isinstance(cls, type) and issubclass(cls, SQLModel)
                                      and cls.__init__ is SQLModel.__init__
                                      and not cls.model_config.get("table"))
        except ImportError:
            pass
    if schema.get("serialization") or (schema.get("custom_init") and not standard_sqlmodel_init) or schema.get("post_init"):
        return False
    # JSON-schema metadata contains callbacks which do not execute when a
    # response is serialized. Every actual nested core schema is checked.
    return all(_safe_response_schema(value, depth + 1, allow_computed=allow_computed)
               for key, value in schema.items() if key not in {"metadata", "config", "cls"})


def _validation_snapshot(source: Any, model: Any, depth: int = 0, seen: Any = None,
                         remaining: Any = None) -> Any:
    """Observe mapped, loaded inputs only; never evaluate a relationship getter."""
    from pydantic import BaseModel
    from sqlalchemy import inspect as orm_inspect
    from sqlalchemy.orm.attributes import NO_VALUE
    if depth > 8 or not isinstance(model, type) or not issubclass(model, BaseModel):
        return None
    if not model.model_config.get("from_attributes"):
        return None
    remaining = [2400] if remaining is None else remaining
    remaining[0] -= 1
    if remaining[0] < 0:
        return None
    seen = set() if seen is None else seen
    if id(source) in seen or len(seen) >= 512:
        return None
    seen.add(id(source))
    try:
        state = orm_inspect(source, raiseerr=False)
        if state is None or not hasattr(state, "mapper") or not _plain_orm_access(type(source)):
            return None
        values, candidates, children = {}, {}, {}
        for name, field in model.model_fields.items():
            remaining[0] -= 1
            if remaining[0] < 0:
                break
            alias = field.validation_alias if field.validation_alias is not None else field.alias
            key = alias if isinstance(alias, str) else name if alias is None else None
            if key is None or key not in state.attrs:
                continue
            value = state.attrs[key].loaded_value
            if value is NO_VALUE:
                continue
            if key in state.mapper.column_attrs:
                origin = _observed_attribute_origin(source, key, value)
                if origin is not None:
                    values[key] = value
                    candidates[key] = (value, origin)
            elif key in state.mapper.relationships:
                kind = field.annotation
                args = get_args(kind)
                if get_origin(kind) in (Union, types.UnionType):
                    choices = [item for item in args if item is not type(None)]
                    kind = choices[0] if len(choices) == 1 else None
                child = _validation_snapshot(value, kind, depth + 1, seen, remaining)
                if child is not None:
                    children[name] = (key, value, child)
        return source, model, values, candidates, children
    except Exception:
        return None
    finally:
        seen.discard(id(source))


def _record_validation_snapshot(registration: Any, result: Any, snapshot: Any,
                                filename: str, line: int) -> Any:
    if snapshot is None:
        return result
    source, model, values, candidates, children = snapshot
    if type(result) is not model:
        return result
    try:
        from sqlalchemy import inspect as orm_inspect
        state = orm_inspect(source, raiseerr=False)
        candidates = {name: candidate for name, candidate in candidates.items()
                      if _observed_attribute_origin(source, name, candidate[0]) == candidate[1]}
        output = object.__getattribute__(result, "__dict__")
        for name, (key, value, child) in children.items():
            if name in output and state.attrs[key].loaded_value is value:
                _record_validation_snapshot(registration, output[name], child, filename, line)
        return _record_dto_projection(registration, result, model, values, candidates, filename, line)
    except Exception:
        return result


def _dto_fingerprint(trace: Trace, value: Any) -> str | None:
    """An ephemeral keyed mutation guard, never a value-to-origin lookup."""
    if not _immutable_value(value) or id(value) in trace._immutable_mutations:
        return None
    if isinstance(value, str) and len(value) > 100000:
        return None
    try:
        enum_value = _enum_value(value)
        if enum_value is not _NO_ENUM_VALUE:
            kind = type(value)
            description = (type.__getattribute__(kind, "__module__"), type.__getattribute__(kind, "__qualname__"),
                           id(value), type(enum_value).__name__, enum_value)
            raw = ("Enum\0" + repr(description)).encode("utf-8", "surrogatepass")
        else:
            raw = (type(value).__name__ + "\0" + repr(value)).encode("utf-8", "surrogatepass")
        return hashlib.blake2b(raw, key=trace._dto_value_key, digest_size=16).hexdigest()
    except (ValueError, OverflowError):
        return None


def _immutable_value(value: Any) -> bool:
    return (type(value) in (str, int, float, bool, type(None), uuid.UUID, date)
            or type(value) is datetime and (value.tzinfo is None or type(value.tzinfo) is timezone)
            or _enum_value(value) is not _NO_ENUM_VALUE)


def _enum_value(value: Any) -> Any:
    if not any(base is Enum for base in type.__getattribute__(type(value), "__mro__")):
        return _NO_ENUM_VALUE
    try:
        kind = type(value)
        if (kind.__getattribute__ is not object.__getattribute__
                or inspect.getattr_static(kind, "value") is not inspect.getattr_static(Enum, "value")
                or inspect.getattr_static(kind, "_value_", _NO_ENUM_VALUE) is not _NO_ENUM_VALUE
                or inspect.getattr_static(kind, "__repr__") is not Enum.__repr__
                or not any(inspect.getattr_static(kind, "__str__") is method
                           for method in (Enum.__str__, str.__str__, int.__repr__))):
            return _NO_ENUM_VALUE
        descriptor = inspect.getattr_static(kind, "__dict__", None)
        if type(descriptor) is not types.GetSetDescriptorType:
            return _NO_ENUM_VALUE
        namespace = object.__getattribute__(value, "__dict__")
        if type(namespace) is not dict:
            return _NO_ENUM_VALUE
        raw, name = namespace.get("_value_", _NO_ENUM_VALUE), namespace.get("_name_")
        members = type.__getattribute__(kind, "_member_map_")
        if (type(raw) not in (str, int, bool) or type(name) is not str
                or type(members) is not dict or members.get(name) is not value):
            return _NO_ENUM_VALUE
        return raw
    except (AttributeError, TypeError):
        return _NO_ENUM_VALUE


def _serialized_same(trace: Trace, value: Any, encoded: Any, fingerprint: str) -> bool:
    if _dto_fingerprint(trace, value) != fingerprint:
        return False
    if type(value) in (str, int, float, bool, type(None)):
        return _dto_fingerprint(trace, encoded) == fingerprint
    enum_value = _enum_value(value)
    if enum_value is not _NO_ENUM_VALUE:
        return type(encoded) is type(enum_value) and encoded == enum_value
    if type(encoded) is not str:
        return False
    if type(value) is uuid.UUID:
        return encoded == str(value)
    if type(value) is date:
        return encoded == date.isoformat(value)
    if type(value) is datetime and _immutable_value(value):
        canonical = datetime.isoformat(value)
        # Pydantic uses Z for exact UTC; jsonable_encoder uses +00:00.
        return encoded == canonical or canonical.endswith("+00:00") and encoded == canonical[:-6] + "Z"
    return False


def _dto_attribute(instance: Any, attribute: str) -> tuple[Any, Any]:
    # This is the application's one original attribute read. The internal
    # pair is unwrapped before invoking its constructor; application values
    # never become tracing wrapper objects.
    value = getattr(instance, attribute)
    return value, _observed_attribute_origin(instance, attribute, value)


def _dto_isoformat(instance: Any, attribute: str) -> tuple[Any, Any]:
    value = getattr(instance, attribute)
    result = value.isoformat()
    origin = None
    if (type(value) in (date, datetime) and _immutable_value(value) and type(result) is str):
        direct = _observed_attribute_origin(instance, attribute, value)
        if direct is not None:
            origin = {**direct, "transformation": "isoformat"}
    return result, origin


def _plain_orm_access(kind: Any) -> bool:
    if kind.__getattribute__ is not object.__getattribute__:
        return False
    fallback = inspect.getattr_static(kind, "__getattr__", None)
    if fallback is None:
        return True
    try:
        from sqlmodel import SQLModel
        return issubclass(kind, SQLModel) and fallback is SQLModel.__getattr__
    except ImportError:
        return False


def _observed_attribute_origin(instance: Any, attribute: str, value: Any) -> Any:
    trace = _current.get()
    origin = None
    if trace and not trace.closed and trace._response_model_token is not None:
        try:
            from sqlalchemy import inspect as orm_inspect
            state = orm_inspect(instance, raiseerr=False)
            if (state is not None and hasattr(state, "mapper")
                    and _plain_orm_access(type(instance))
                    and attribute in state.mapper.column_attrs
                    and value is state.attrs[attribute].loaded_value):
                origin = _orm_origin(trace, instance, attribute)
        except Exception:
            pass
    return origin


def _dictionary_getattr(function: Any, instance: Any, attribute: Any) -> tuple[Any, Any]:
    value = function(instance, attribute)
    origin = (_observed_attribute_origin(instance, attribute, value)
              if function is builtins.getattr and type(attribute) is str else None)
    return value, origin


def _dictionary_construct(registration: Any, entries: Any, filename: str, line: int,
                          *, paired: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {}
    candidates: dict[str, Any] = {}
    items = entries.items() if paired else entries
    for name, pair in items:
        result[name] = pair[0]
        # Last assignment wins, including a literal that replaces an attribute.
        candidates.pop(name, None)
        if type(name) is str and pair[1] is not None:
            candidates[name] = pair[1]
    return _dictionary_record(registration, result, candidates, filename, line)


def _dictionary_record(registration: Any, result: dict[str, Any], candidates: dict[str, Any],
                        filename: str, line: int) -> dict[str, Any]:
    trace = _current.get()
    if (not registration.active or not trace or trace.closed
            or trace._response_model_token is None or not candidates
            or len(trace.dictionary_origins) >= _RESPONSE_FIELDS):
        return result
    try:
        site = trace.site(filename, line, "dict")
        if site is None:
            return result
        origins = {}
        for name, origin in candidates.items():
            if not _dictionary_key(name):
                continue
            if trace._dto_field_count + trace._dictionary_field_count >= _RESPONSE_FIELDS:
                trace.truncated = True
                break
            fingerprint = _dto_fingerprint(trace, result[name])
            if fingerprint is not None:
                origins[name] = {"origin": {**origin, "projection": site}, "fingerprint": fingerprint}
                trace._dictionary_field_count += 1
        if origins:
            trace.dictionary_origins[id(result)] = (result, origins)
    except Exception:
        pass
    return result


def _dictionary_comprehension(registration: Any, make: Any, filename: str, line: int) -> Any:
    builder = {"origins": {}, "safe": True}
    result = make(builder)
    if not builder["safe"]:
        return result
    return _dictionary_record(registration, result, builder["origins"], filename, line)


def _dictionary_comp_value(builder: Any, key: Any, pair: Any) -> Any:
    if not _dictionary_key(key):
        builder["safe"] = False
        builder["origins"].clear()
    elif builder["safe"]:
        builder["origins"].pop(key, None)
        if pair[1] is not None:
            if len(builder["origins"]) < _RESPONSE_FIELDS:
                builder["origins"][key] = pair[1]
            else:
                trace = _current.get()
                if trace and not trace.closed:
                    trace.truncated = True
    return pair[0]


def _dictionary_key(key: Any) -> bool:
    return _dictionary_output_key(key) is not None


def _dictionary_output_key(key: Any) -> str | None:
    # UUID keys have one canonical JSON spelling. Arbitrary __str__ methods do
    # not participate in field paths or choose an origin.
    if type(key) is uuid.UUID:
        key = str(key)
    return (key if type(key) is str and bool(key) and len(key) <= 200 and "." not in key
            and key not in {"__proto__", "constructor", "prototype"} else None)


def _dictionary_invalidate(value: Any, keys: Any = None) -> Any:
    if type(value) is list:
        _collection_invalidate(value)
    trace = _current.get()
    if trace and not trace.closed and type(value) is dict:
        entry = trace.dictionary_origins.get(id(value))
        if entry and entry[0] is value:
            if keys is None:
                entry[1].clear()
            else:
                for key in keys:
                    if type(key) is str:
                        entry[1].pop(key, None)
                    else:
                        entry[1].clear()
                        break
    return value


def _projection_mutation(value: Any, attribute: str) -> Any:
    trace = _current.get()
    if trace and not trace.closed:
        result = trace.row_results.get(id(value))
        if result and result["result"]() is value:
            result["valid"] = False
        collection = trace._collection_results.get(id(value))
        if collection and collection["result"] is value:
            collection["valid"] = False
        if any(base is Enum for base in type.__getattribute__(type(value), "__mro__")):
            trace._immutable_mutations.add(id(value))
        entry = trace.dto_origins.get(id(value))
        if entry and entry[0]() is value:
            entry[1].pop(attribute, None)
    return value


def _dictionary_escape(value: Any, seen: set[int], remaining: list[int]) -> None:
    if remaining[0] <= 0:
        _dictionary_boundary(None)
        return
    if id(value) in seen:
        return
    remaining[0] -= 1
    seen.add(id(value))
    trace = _current.get()
    entry = trace.dto_origins.get(id(value)) if trace and not trace.closed else None
    result = trace.row_results.get(id(value)) if trace and not trace.closed else None
    if result and result["result"]() is value:
        result["valid"] = False
    collection = trace._collection_results.get(id(value)) if trace and not trace.closed else None
    if collection and collection["result"] is value:
        collection["valid"] = False
    if type(value) is list:
        _collection_invalidate(value)
    if trace and not trace.closed and any(base is Enum for base in type.__getattribute__(type(value), "__mro__")):
        trace._immutable_mutations.add(id(value))
    if entry and entry[0]() is value:
        entry[1].clear()
        for child in object.__getattribute__(value, "__dict__").values():
            _dictionary_escape(child, seen, remaining)
    if type(value) is dict:
        _dictionary_invalidate(value)
        for child in value.values():
            _dictionary_escape(child, seen, remaining)
    elif type(value) in (list, tuple):
        for child in value:
            _dictionary_escape(child, seen, remaining)


def _dictionary_boundary(value: Any) -> Any:
    # Dynamic/frame-sensitive calls execute in the application's own frame.
    # Their side effects cannot be observed, so discard optional dict claims.
    trace = _current.get()
    if trace and not trace.closed:
        for _, origins in trace.dictionary_origins.values():
            origins.clear()
        for _, origins in trace.dto_origins.values():
            origins.clear()
        for entry in trace.row_results.values():
            entry["valid"] = False
        for entry in trace._collection_results.values():
            entry["valid"] = False
        for _, entry in trace._collection_lists.values():
            entry["valid"] = False
    return value


def _projection_escape(value: Any) -> Any:
    try:
        _dictionary_escape(value, set(), [12000])
    except Exception:
        _dictionary_boundary(None)
    return value


def _instrumented_function(function: Any) -> bool:
    if type(function) is types.MethodType:
        function = function.__func__
    if type(function) is not types.FunctionType:
        return False
    entry = _instrumented_codes.get(id(function.__code__))
    registration = entry[1]() if entry else None
    return bool(entry and entry[0]() is function.__code__ and registration and registration.active)


def _external_value(value: Any, seen: set[int], remaining: list[int]) -> None:
    _dictionary_escape(value, seen, remaining)
    if type(value) in (dict, list, tuple, types.FunctionType, types.ModuleType, type):
        return
    descriptor = inspect.getattr_static(type(value), "__dict__", None)
    if type(descriptor) is types.GetSetDescriptorType:
        try:
            namespace = object.__getattribute__(value, "__dict__")
            if type(namespace) is dict:
                for child in namespace.values():
                    _dictionary_escape(child, seen, remaining)
        except (AttributeError, TypeError):
            pass


def _external_function(function: Any, seen: set[int], remaining: list[int]) -> None:
    if type(function) is types.MethodType:
        _external_value(function.__self__, seen, remaining)
        function = function.__func__
    if type(function) is not types.FunctionType:
        return
    for cell in function.__closure__ or ():
        try:
            _external_value(cell.cell_contents, seen, remaining)
        except ValueError:
            pass  # An empty closure cell has no application value to escape.
    names = set(function.__code__.co_names)
    for name in names:
        if name not in function.__globals__:
            continue
        value = function.__globals__[name]
        if type(value) is types.ModuleType:
            for attribute in names:
                if attribute in vars(value):
                    _external_value(vars(value)[attribute], seen, remaining)
        else:
            _external_value(value, seen, remaining)


def _dictionary_callable(registration: Any, function: Any, filename: str = "", line: int = 0) -> Any:
    trace = _current.get()
    if not registration.active or not trace or trace.closed:
        return function

    def observe(args: Any, kwargs: Any) -> None:
        from sqlalchemy.engine.result import Result
        if (type(function) is types.MethodType and function.__func__ is Result.scalars
                and id(function.__self__) in trace._collection_results):
            return
        if any(function is operation for operation in (setattr, delattr)) and len(args) >= 2 and type(args[1]) is str:
            _projection_mutation(args[0], args[1])
            for value in args[2:]:
                _projection_escape(value)
            return
        if _instrumented_function(function):
            return
        if any(base is type for base in type.__getattribute__(type(function), "__mro__")):
            from pydantic import BaseModel
            if (issubclass(function, BaseModel) and function.__init__ is BaseModel.__init__
                    and function.__new__ is object.__new__
                    and _safe_response_schema(function.__pydantic_core_schema__)):
                return
        owner, name = None, None
        if type(function) is types.BuiltinMethodType:
            owner, name = function.__self__, function.__name__
        elif any(function is method for method in (dict.update, dict.clear, dict.pop, dict.popitem,
                           dict.setdefault, dict.__setitem__, dict.__delitem__, dict.__ior__)):
            owner, name = (args[0] if args else None), function.__name__
        arguments = args[1:] if owner is not None and type(function) is not types.BuiltinMethodType else args
        if type(owner) is list and name != "copy":
            _collection_invalidate(owner)
        if type(owner) is dict:
            if name == "update":
                keys = list(kwargs)
                if len(arguments) == 1 and type(arguments[0]) is dict:
                    keys.extend(arguments[0])
                elif arguments:
                    keys = None
                _dictionary_invalidate(owner, keys)
            elif name in {"pop", "setdefault", "__setitem__", "__delitem__"}:
                _dictionary_invalidate(owner, arguments[:1] if arguments else None)
            elif name in {"get", "__contains__", "__getitem__"} and arguments and type(arguments[0]) is not str:
                _dictionary_invalidate(owner)
            elif name not in {"get", "items", "keys", "values", "copy", "__len__", "__iter__",
                              "__contains__", "__getitem__"}:
                _dictionary_invalidate(owner)
            return
        # These operations retain references and do not invoke application
        # callbacks or mutate a dictionary being passed as a value.
        if (type(owner) is list and name in {"append", "copy", "reverse"}
                or function is len and len(args) == 1 and type(args[0]) in (dict, list, tuple)
                or any(function is kind for kind in (list, tuple, dict))
                   and len(args) == 1 and type(args[0]) in (dict, list, tuple)):
            return
        seen: set[int] = set()
        remaining = [2400]
        for value in (*args, *kwargs.values()):
            _dictionary_escape(value, seen, remaining)
        _external_function(function, seen, remaining)
    def invoke(*args: Any, **kwargs: Any) -> Any:
        # Standard Pydantic from-attributes validation copies ORM scalars into
        # a new DTO. Observe that exact call and its already loaded inputs.
        # No getters are invoked here and equal unrelated values never qualify.
        from pydantic import BaseModel
        owner = function.__self__ if type(function) is types.MethodType else None
        validators = [BaseModel.model_validate.__func__]
        try:
            from sqlmodel import SQLModel
            validators.append(SQLModel.model_validate.__func__)
        except ImportError:
            pass
        standard_validate = (type(function) is types.MethodType
                             and function.__func__ in validators
                             and isinstance(owner, type) and issubclass(owner, BaseModel)
                             and _safe_response_schema(owner.__pydantic_core_schema__, allow_computed=True)
                             and kwargs.get("from_attributes", owner.model_config.get("from_attributes")))
        if standard_validate:
            source = args[0] if args else kwargs.get("obj")
            snapshot = None if kwargs.get("update") else _validation_snapshot(source, owner)
            result = function(*args, **kwargs)
            return _record_validation_snapshot(registration, result, snapshot, filename, line)
        collection = None
        try:
            collection = _collection_all_call(trace, function, args, kwargs)
        except Exception:
            pass
        if collection:
            owner, record = collection
            record["consumed"] = True
            result = function(*args, **kwargs)
            try:
                if _collection_result_valid(record, owner, after=True):
                    _collection_record(trace, result, [record["query"]["id"]], trace.site(filename, line, "all"))
            except Exception:
                pass
            return result
        try:
            observe(args, kwargs)
        except Exception:
            _dictionary_boundary(None)
        # Application exceptions propagate once, outside optional observation.
        result = function(*args, **kwargs)
        if not args:
            try:
                _validated_dictionary_copies(trace, function, kwargs, result)
            except Exception:
                pass
        return result

    return invoke


def _validated_dictionary_copies(trace: Trace, constructor: Any, arguments: dict[str, Any], result: Any) -> None:
    """Retain keyed provenance through standard Pydantic dictionary validation.

    The declared key type chooses the structural entry. Fingerprints only
    verify that that known entry survived validation; they never find origins.
    """
    from pydantic import BaseModel
    if (not any(base is type for base in type.__getattribute__(type(constructor), "__mro__"))
            or not issubclass(constructor, BaseModel) or type(result) is not constructor
            or constructor.__init__ is not BaseModel.__init__ or constructor.__new__ is not object.__new__
            or constructor.__getattribute__ is not object.__getattribute__
            or not _safe_response_schema(constructor.__pydantic_core_schema__)):
        return
    values = object.__getattribute__(result, "__dict__")
    config = constructor.model_config
    for name, field in constructor.model_fields.items():
        kind = field.annotation
        types_ = get_args(kind)
        if get_origin(kind) is list and name in values:
            alias = field.validation_alias if field.validation_alias is not None else field.alias
            if alias is not None and type(alias) is not str:
                continue
            keys = [alias] if alias is not None and config.get("validate_by_alias", True) else [name]
            if alias is not None and config.get("validate_by_alias", True) and (
                    config.get("populate_by_name") or config.get("validate_by_name")):
                keys.append(name)
            source_key = next((key for key in keys if key in arguments), None)
            source, target = arguments.get(source_key), values[name]
            entry = _collection_entry(trace, source)
            if (entry and type(target) is list and len(source) == len(target)
                    and all(left is right for left, right in zip(source, target))):
                _collection_record(trace, target, entry["queries"], entry["source"])
            continue
        if get_origin(kind) is not dict or not types_ or types_[0] not in (str, uuid.UUID) or name not in values:
            continue
        alias = field.validation_alias if field.validation_alias is not None else field.alias
        if alias is not None and type(alias) is not str:
            continue
        keys = [alias] if alias is not None and config.get("validate_by_alias", True) else [name]
        if alias is not None and config.get("validate_by_alias", True) and (
                config.get("populate_by_name") or config.get("validate_by_name")):
            keys.append(name)
        source_key = next((key for key in keys if key in arguments), None)
        source, target = arguments.get(source_key), values[name]
        if type(source) is not dict or type(target) is not dict or len(source) != len(target):
            continue
        entry = trace.dictionary_origins.get(id(source))
        if not entry or entry[0] is not source or len(trace.dictionary_origins) >= _RESPONSE_FIELDS:
            continue
        # Exact built-in key types avoid application hashing/equality hooks and
        # reject coercion or collisions while preserving UUID identity keys.
        if not all(type(key) is types_[0] and key in target for key in source) or not all(type(key) is types_[0] for key in target):
            continue
        origins = {key: captured for key, captured in entry[1].items()
                   if key in source and key in target
                   and _dto_fingerprint(trace, source[key]) == captured["fingerprint"]
                   and _dto_fingerprint(trace, target[key]) == captured["fingerprint"]}
        if origins:
            trace.dictionary_origins[id(target)] = (target, origins)


_ARITHMETIC = {"add": operator.add, "subtract": operator.sub,
               "multiply": operator.mul, "divide": operator.truediv}


def _dto_constant(value: Any) -> tuple[Any, Any]:
    # Values remain ordinary application primitives. Constants are never stored
    # in evidence; only the presence of a literal operand is recorded.
    return value, {"kind": "constant"}


def _dto_binary(operation: str, left: Any, right: Any) -> tuple[Any, Any]:
    value = _ARITHMETIC[operation](left[0], right[0])
    trace = _current.get()
    if not trace or trace.closed or trace._response_model_token is None:
        return value, None
    try:
        # Exact primitive types avoid custom numeric operators/coercions. Calls,
        # Decimal/custom values, unloaded/mutated attributes and validators stay
        # unsupported instead of acquiring origins from equal scalar values.
        if any(type(item) not in (int, float) or not math.isfinite(item)
               for item in (left[0], right[0], value)):
            return value, None

        def operand(origin: Any) -> tuple[Any, list[Any]]:
            if not isinstance(origin, dict):
                raise ValueError("Uncaptured arithmetic operand")
            if origin.get("kind") == "constant":
                return {"kind": "constant"}, []
            if origin.get("kind") == "computed":
                return origin["operation"], origin["inputs"]
            return {"kind": "column", **origin}, [origin]

        left_operation, left_inputs = operand(left[1])
        right_operation, right_inputs = operand(right[1])
        inputs = left_inputs + right_inputs
        if not inputs:
            return value, {"kind": "constant"}
        if len(inputs) > 8:
            return value, None
        queries = list(dict.fromkeys(query for item in inputs for query in item["queries"]))
        return value, {"kind": "computed", "inputs": inputs, "queries": queries,
                       "operation": {"op": operation, "left": left_operation,
                                     "right": right_operation}}
    except Exception:
        return value, None


def _dto_construct(registration: Any, constructor: Any, entries: list[Any],
                   filename: str, line: int) -> Any:
    kwargs = {name: pair[0] for name, pair in entries}
    result = _dictionary_callable(registration, constructor)(**kwargs)
    candidates = {name: pair for name, pair in entries
                  if pair[1] is not None and pair[1].get("kind") != "constant"}
    return _record_dto_projection(registration, result, constructor, kwargs, candidates, filename, line)


def _record_dto_projection(registration: Any, result: Any, constructor: Any, kwargs: dict[str, Any],
                           candidates: dict[str, Any], filename: str, line: int) -> Any:
    trace = _current.get()
    if (not registration.active or not trace or trace.closed
            or trace._response_model_token is None or len(trace.dto_origins) >= 512):
        return result
    try:
        from pydantic import BaseModel
        if (not any(base is type for base in type.__getattribute__(type(constructor), "__mro__")) or not issubclass(constructor, BaseModel)
                or type(result) is not constructor
                or constructor.__getattribute__ is not object.__getattribute__
                or not _safe_response_schema(constructor.__pydantic_core_schema__, allow_computed=True)):
            return result
        site = trace.site(filename, line, constructor.__name__)
        if site is None:
            return result
        values = object.__getattribute__(result, "__dict__")
        origins = {}
        config = constructor.model_config
        for name, field in constructor.model_fields.items():
            alias = field.validation_alias if field.validation_alias is not None else field.alias
            if alias is not None and not isinstance(alias, str):
                continue
            names = [alias] if alias is not None and config.get("validate_by_alias", True) else [name]
            if alias is not None and config.get("validate_by_alias", True) and (
                    config.get("populate_by_name") or config.get("validate_by_name")):
                names.append(name)
            source_name = next((key for key in names if key in kwargs), None)
            candidate = candidates.get(source_name)
            if candidate is None or name not in values:
                continue
            if trace._dto_field_count + trace._dictionary_field_count >= _RESPONSE_FIELDS:
                trace.truncated = True
                break
            original, origin = candidate
            if origin.get("kind") == "computed" and (
                    not config.get("frozen") or constructor.__setattr__ is not BaseModel.__setattr__):
                # A fingerprint cannot detect assignment of the same scalar.
                # Computed provenance requires the model's normal immutable
                # contract; mutable DTOs and built-in dicts remain unsupported.
                continue
            if origin.get("kind") == "computed":
                origin = {**origin, "immutable": True}
            value = values[name]
            fingerprint = _dto_fingerprint(trace, value)
            enum_value = _enum_value(original)
            unchanged = type(value) is type(original) and value == original
            if (not unchanged and enum_value is not _NO_ENUM_VALUE and type(value) is type(enum_value)
                    and value == enum_value and _dto_fingerprint(trace, original) is not None):
                unchanged = True
                origin = {**origin, "transformation": "enum-value"}
            validated_enum = _enum_value(value)
            if (not unchanged and validated_enum is not _NO_ENUM_VALUE
                    and type(original) is type(validated_enum) and original == validated_enum):
                unchanged = True
                origin = {**origin, "transformation": "enum-validation"}
            if fingerprint is not None and unchanged:
                origins[name] = {"origin": {**origin, "projection": site}, "fingerprint": fingerprint}
                trace._dto_field_count += 1
        if origins:
            trace.dto_origins[id(result)] = (weakref.ref(result), origins)
    except Exception:
        pass  # Capturing an optional projection cannot change the constructor.
    return result


def _dictionary_call_key(filename: str, line: int, column: int) -> Any:
    current = inspect.currentframe()
    frame = current.f_back if current else None
    try:
        for _ in range(6):
            if frame is None:
                return None
            if frame.f_code.co_filename == filename:
                return id(frame), filename, line, column
            frame = frame.f_back
    finally:
        del frame
        del current


def _dto_keyword_mapping(mapping: Any, filename: str, line: int, column: int) -> Any:
    trace = _current.get()
    if not trace or trace.closed or type(mapping) is not dict:
        return mapping
    key = _dictionary_call_key(filename, line, column)
    builder = trace._dictionary_keyword_calls.get(key)
    entry = trace.dictionary_origins.get(id(mapping))
    if builder is not None and entry and entry[0] is mapping:
        for name, captured in entry[1].items():
            projection = captured["origin"]["projection"]
            if (name in mapping and _dto_fingerprint(trace, mapping[name]) == captured["fingerprint"]
                    and trace.site(str(trace.root / projection["path"]), projection["line"], projection["name"]) == projection):
                builder[name] = captured
    return mapping


def _dto_keyword_callable(registration: Any, constructor: Any, filename: str, line: int, column: int) -> Any:
    trace = _current.get()
    if not registration.active or not trace or trace.closed or trace._response_model_token is None:
        return constructor
    from pydantic import BaseModel
    if (not any(base is type for base in type.__getattribute__(type(constructor), "__mro__")) or not issubclass(constructor, BaseModel)
            or not _safe_response_schema(constructor.__pydantic_core_schema__)
            or len(trace._dictionary_keyword_calls) >= 256):
        return _dictionary_callable(registration, constructor)
    key = _dictionary_call_key(filename, line, column)
    if key is None:
        return constructor
    builder: dict[str, Any] = {}
    trace._dictionary_keyword_calls[key] = builder

    def construct(**kwargs: Any) -> Any:
        try:
            result = constructor(**kwargs)
            candidates = {name: (kwargs[name], captured["origin"])
                          for name, captured in builder.items() if name in kwargs
                          and _dto_fingerprint(trace, kwargs[name]) == captured["fingerprint"]}
            return _record_dto_projection(registration, result, constructor, kwargs, candidates, filename, line)
        finally:
            if trace._dictionary_keyword_calls.get(key) is builder:
                trace._dictionary_keyword_calls.pop(key, None)

    return construct


class _ProjectionTransformer(ast.NodeTransformer):
    construct_name = "_anvaya_projection_construct_v1"
    attribute_name = "_anvaya_projection_attribute_v1"
    binary_name = "_anvaya_projection_binary_v1"
    constant_name = "_anvaya_projection_constant_v1"
    isoformat_name = "_anvaya_projection_isoformat_v1"
    keyword_callable_name = "_anvaya_projection_keyword_callable_v1"
    keyword_mapping_name = "_anvaya_projection_keyword_mapping_v1"

    def __init__(self, filename: str) -> None:
        self.filename = filename
        self.changed = False

    def supported(self, value: Any, depth: int = 0) -> bool:
        if depth > 4:
            return False
        if isinstance(value, ast.Attribute):
            return not value.attr.startswith("__") or value.attr.endswith("__")
        if self.isoformat_attribute(value):
            return True
        if isinstance(value, ast.Constant):
            return type(value.value) in (int, float)
        if isinstance(value, ast.BinOp) and type(value.op) in (ast.Add, ast.Sub, ast.Mult, ast.Div):
            return self.supported(value.left, depth + 1) and self.supported(value.right, depth + 1)
        return False

    @staticmethod
    def isoformat_attribute(value: Any) -> bool:
        return (isinstance(value, ast.Call) and not value.args and not value.keywords
                and isinstance(value.func, ast.Attribute) and value.func.attr == "isoformat"
                and isinstance(value.func.value, ast.Attribute)
                and not value.func.value.attr.startswith("__"))

    def pair(self, value: Any) -> Any:
        if self.isoformat_attribute(value):
            attribute = value.func.value
            return ast.copy_location(ast.Call(func=ast.Name(id=self.isoformat_name, ctx=ast.Load()),
                args=[attribute.value, ast.Constant(value=attribute.attr)], keywords=[]), value)
        if isinstance(value, ast.Attribute):
            return ast.copy_location(ast.Call(func=ast.Name(id=self.attribute_name, ctx=ast.Load()),
                args=[value.value, ast.Constant(value=value.attr)], keywords=[]), value)
        if isinstance(value, ast.BinOp) and self.supported(value):
            operation = {ast.Add: "add", ast.Sub: "subtract", ast.Mult: "multiply", ast.Div: "divide"}[type(value.op)]
            return ast.copy_location(ast.Call(func=ast.Name(id=self.binary_name, ctx=ast.Load()),
                args=[ast.Constant(value=operation), self.pair(value.left), self.pair(value.right)], keywords=[]), value)
        if isinstance(value, ast.Constant) and type(value.value) in (int, float):
            return ast.copy_location(ast.Call(func=ast.Name(id=self.constant_name, ctx=ast.Load()),
                args=[value], keywords=[]), value)
        return ast.Tuple(elts=[value, ast.Constant(value=None)], ctx=ast.Load())

    def visit_Call(self, node: Any) -> Any:
        self.generic_visit(node)
        if not node.args and any(keyword.arg is None for keyword in node.keywords):
            self.changed = True
            for keyword in node.keywords:
                if keyword.arg is None:
                    keyword.value = ast.copy_location(ast.Call(
                        func=ast.Name(id=self.keyword_mapping_name, ctx=ast.Load()),
                        args=[keyword.value, ast.Constant(value=self.filename), ast.Constant(value=node.lineno),
                              ast.Constant(value=node.col_offset)], keywords=[]), keyword.value)
            node.func = ast.copy_location(ast.Call(func=ast.Name(id=self.keyword_callable_name, ctx=ast.Load()),
                args=[node.func, ast.Constant(value=self.filename), ast.Constant(value=node.lineno),
                      ast.Constant(value=node.col_offset)], keywords=[]), node.func)
            return node
        if (node.args or not node.keywords or any(keyword.arg is None for keyword in node.keywords)
                # Leave private attributes in the class compiler's scope so
                # Python can apply its normal __name mangling, even for non-DTO calls.
                or any(isinstance(keyword.value, ast.Attribute)
                       and keyword.value.attr.startswith("__")
                       and not keyword.value.attr.endswith("__") for keyword in node.keywords)
                or not any(self.supported(keyword.value)
                           and any(isinstance(child, ast.Attribute) for child in ast.walk(keyword.value))
                           for keyword in node.keywords)):
            return node
        entries = []
        for keyword in node.keywords:
            value = keyword.value
            pair = self.pair(value) if self.supported(value) else ast.Tuple(elts=[value, ast.Constant(value=None)], ctx=ast.Load())
            entries.append(ast.Tuple(elts=[ast.Constant(value=keyword.arg), pair], ctx=ast.Load()))
        self.changed = True
        return ast.copy_location(ast.Call(func=ast.Name(id=self.construct_name, ctx=ast.Load()),
            args=[node.func, ast.List(elts=entries, ctx=ast.Load()), ast.Constant(value=self.filename),
                  ast.Constant(value=node.lineno)], keywords=[]), node)


class _DictionaryTransformer(ast.NodeTransformer):
    construct_name = "_anvaya_dictionary_construct_v1"
    comprehension_name = "_anvaya_dictionary_comprehension_v1"
    comp_value_name = "_anvaya_dictionary_comp_value_v1"
    getattr_name = "_anvaya_dictionary_getattr_v1"
    callable_name = "_anvaya_dictionary_callable_v1"
    mutation_name = "_anvaya_dictionary_mutation_v1"
    boundary_name = "_anvaya_dictionary_boundary_v1"
    attribute_mutation_name = "_anvaya_projection_mutation_v1"
    escape_name = "_anvaya_projection_escape_v1"
    builder_name = "_anvaya_dictionary_builder_v1"
    row_iteration_name = "_anvaya_row_iteration_v1"
    row_pair_name = "_anvaya_row_pair_v1"
    row_choose_name = "_anvaya_row_choose_v1"
    list_comprehension_name = "_anvaya_collection_comprehension_v1"
    list_iteration_name = "_anvaya_collection_iteration_v1"
    slice_name = "_anvaya_collection_slice_v1"
    names = {construct_name, comprehension_name, comp_value_name, getattr_name,
             callable_name, mutation_name, boundary_name, builder_name, attribute_mutation_name, escape_name,
             row_iteration_name, row_pair_name, row_choose_name,
             list_comprehension_name, list_iteration_name, slice_name,
             _ProjectionTransformer.construct_name, _ProjectionTransformer.attribute_name,
             _ProjectionTransformer.binary_name, _ProjectionTransformer.constant_name, _ProjectionTransformer.isoformat_name,
             _ProjectionTransformer.keyword_callable_name, _ProjectionTransformer.keyword_mapping_name}

    def __init__(self, filename: str) -> None:
        self.filename, self.changed = filename, False
        self.nonlocal_names: list[set[str] | None] = [None]

    @staticmethod
    def direct(value: Any) -> bool:
        if isinstance(value, ast.Attribute):
            return not value.attr.startswith("__") or value.attr.endswith("__")
        return (_ProjectionTransformer.isoformat_attribute(value)
                or isinstance(value, ast.Call) and isinstance(value.func, ast.Name)
                and value.func.id == "getattr" and len(value.args) == 2 and not value.keywords)

    def pair(self, value: Any) -> Any:
        if _ProjectionTransformer.isoformat_attribute(value):
            attribute = value.func.value
            return ast.copy_location(ast.Call(func=ast.Name(id=_ProjectionTransformer.isoformat_name, ctx=ast.Load()),
                args=[self.visit(attribute.value), ast.Constant(value=attribute.attr)], keywords=[]), value)
        if isinstance(value, ast.Attribute) and self.direct(value):
            return ast.copy_location(ast.Call(func=ast.Name(id=_ProjectionTransformer.attribute_name, ctx=ast.Load()),
                args=[self.visit(value.value), ast.Constant(value=value.attr)], keywords=[]), value)
        if self.direct(value):
            return ast.copy_location(ast.Call(func=ast.Name(id=self.getattr_name, ctx=ast.Load()),
                args=[value.func, *[self.visit(argument) for argument in value.args]], keywords=[]), value)
        return ast.Tuple(elts=[self.visit(value), ast.Constant(value=None)], ctx=ast.Load())

    def visit_Dict(self, node: Any) -> Any:
        if (not node.keys or not all(isinstance(key, ast.Constant) and type(key.value) is str for key in node.keys)
                or not any(self.direct(value) for value in node.values)):
            return self.generic_visit(node)
        entries = [ast.Tuple(elts=[key, self.pair(value)], ctx=ast.Load())
                   for key, value in zip(node.keys, node.values)]
        self.changed = True
        return ast.copy_location(ast.Call(func=ast.Name(id=self.construct_name, ctx=ast.Load()),
            args=[ast.List(elts=entries, ctx=ast.Load()), ast.Constant(value=self.filename),
                  ast.Constant(value=node.lineno)], keywords=[]), node)

    def visit_DictComp(self, node: Any) -> Any:
        names = ()
        if len(node.generators) == 1:
            target = node.generators[0].target
            if (isinstance(target, (ast.Tuple, ast.List)) and 1 <= len(target.elts) <= 12
                    and all(isinstance(item, ast.Name) for item in target.elts)):
                names = tuple(item.id for item in target.elts)
                if len(set(names)) != len(names) or node.generators[0].ifs:
                    names = ()
        def row_value(value: Any) -> bool:
            return (isinstance(value, ast.Name) and value.id in names
                    or isinstance(value, ast.Constant) and type(value.value) in (str, int, float, bool, type(None))
                    or isinstance(value, ast.BoolOp) and isinstance(value.op, ast.Or)
                       and all(row_value(item) for item in value.values))
        scalar = bool(names and isinstance(node.key, ast.Name) and node.key.id in names
                      and row_value(node.value)
                      and any(isinstance(item, ast.Name) and item.id in names for item in ast.walk(node.value)))
        if (not isinstance(node.key, ast.Name) or not (scalar or self.direct(node.value))
                or any(isinstance(child, (ast.NamedExpr, ast.Await, ast.Yield, ast.YieldFrom)) for child in ast.walk(node))
                or any(isinstance(child, ast.Call) and (
                    isinstance(child.func, ast.Name) and child.func.id in {"super", "locals", "globals", "vars", "eval", "exec", "dir"}
                    or isinstance(child.func, ast.Attribute) and child.func.attr in {"currentframe", "stack", "_getframe"})
                    for child in ast.walk(node))
                or any(generator.is_async for generator in node.generators)):
            return self.generic_visit(node)
        def row_pair(value: Any) -> Any:
            if isinstance(value, ast.Name):
                return ast.copy_location(ast.Call(func=ast.Name(id=self.row_pair_name, ctx=ast.Load()),
                    args=[ast.Name(id=self.builder_name, ctx=ast.Load()), ast.Constant(value=value.id), value], keywords=[]), value)
            if isinstance(value, ast.BoolOp):
                def choose(index: int) -> Any:
                    left = row_pair(value.values[index])
                    if index + 1 == len(value.values):
                        return left
                    fallback = ast.Lambda(args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[],
                                           kw_defaults=[], defaults=[]), body=choose(index + 1))
                    return ast.Call(func=ast.Name(id=self.row_choose_name, ctx=ast.Load()),
                                    args=[left, fallback], keywords=[])
                return ast.copy_location(choose(0), value)
            return ast.Tuple(elts=[value, ast.Constant(value=None)], ctx=ast.Load())
        value = row_pair(node.value) if scalar else self.pair(node.value)
        node.generators = [self.visit(generator) for generator in node.generators]
        if scalar:
            generator = node.generators[0]
            generator.iter = ast.copy_location(ast.Call(func=ast.Name(id=self.row_iteration_name, ctx=ast.Load()),
                args=[ast.Name(id=self.builder_name, ctx=ast.Load()), generator.iter,
                      ast.Tuple(elts=[ast.Constant(value=name) for name in names], ctx=ast.Load())], keywords=[]), generator.iter)
        node.value = ast.copy_location(ast.Call(func=ast.Name(id=self.comp_value_name, ctx=ast.Load()),
            args=[ast.Name(id=self.builder_name, ctx=ast.Load()), node.key, value], keywords=[]), node.value)
        maker = ast.Lambda(args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=self.builder_name)],
                           kwonlyargs=[], kw_defaults=[], defaults=[]), body=node)
        self.changed = True
        return ast.copy_location(ast.Call(func=ast.Name(id=self.comprehension_name, ctx=ast.Load()),
            args=[maker, ast.Constant(value=self.filename), ast.Constant(value=node.lineno)], keywords=[]), node)

    def visit_Subscript(self, node: Any) -> Any:
        self.generic_visit(node)
        if isinstance(node.ctx, ast.Load) and isinstance(node.slice, ast.Slice):
            self.changed = True
            return ast.copy_location(ast.Call(func=ast.Name(id=self.slice_name, ctx=ast.Load()),
                args=[node.value, *[part if part is not None else ast.Constant(value=None)
                                   for part in (node.slice.lower, node.slice.upper, node.slice.step)],
                      ast.Constant(value=self.filename), ast.Constant(value=node.lineno)], keywords=[]), node)
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            keys = (ast.List(elts=[node.slice], ctx=ast.Load())
                    if isinstance(node.slice, ast.Constant) and type(node.slice.value) is str else ast.Constant(value=None))
            node.value = ast.copy_location(ast.Call(func=ast.Name(id=self.mutation_name, ctx=ast.Load()),
                args=[node.value, keys], keywords=[]), node.value)
            self.changed = True
        return node

    def visit_ListComp(self, node: Any) -> Any:
        if (len(node.generators) != 1 or node.generators[0].is_async or node.generators[0].ifs
                or not isinstance(node.generators[0].target, ast.Name)
                or not isinstance(node.generators[0].iter, ast.Name)
                or any(isinstance(child, (ast.NamedExpr, ast.Await, ast.Yield, ast.YieldFrom)) for child in ast.walk(node))
                or any(isinstance(child, ast.Call) and (
                    isinstance(child.func, ast.Name) and child.func.id in {"super", "locals", "globals", "vars", "eval", "exec", "dir"}
                    or isinstance(child.func, ast.Attribute) and child.func.attr in {"currentframe", "stack", "_getframe"})
                    for child in ast.walk(node))):
            return self.generic_visit(node)
        self.generic_visit(node)
        generator = node.generators[0]
        generator.iter = ast.copy_location(ast.Call(func=ast.Name(id=self.list_iteration_name, ctx=ast.Load()),
            args=[ast.Name(id=self.builder_name, ctx=ast.Load()), generator.iter], keywords=[]), generator.iter)
        maker = ast.Lambda(args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=self.builder_name)],
                           kwonlyargs=[], kw_defaults=[], defaults=[]), body=node)
        self.changed = True
        return ast.copy_location(ast.Call(func=ast.Name(id=self.list_comprehension_name, ctx=ast.Load()),
            args=[maker, ast.Constant(value=self.filename), ast.Constant(value=node.lineno)], keywords=[]), node)

    def visit_FunctionDef(self, node: Any) -> Any:
        # Global/nonlocal storage escapes the local serializer's ownership.
        names = {name for child in ast.walk(node) if isinstance(child, (ast.Global, ast.Nonlocal)) for name in child.names}
        self.nonlocal_names.append(names)
        self.generic_visit(node)
        self.nonlocal_names.pop()
        return node

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Assign(self, node: Any) -> Any:
        escaped = any(isinstance(target, ast.Attribute)
               or isinstance(target, ast.Subscript) and isinstance(target.value, ast.Attribute)
                  and target.value.attr == "__dict__"
               or isinstance(target, ast.Name) and (self.nonlocal_names[-1] is None
                                                    or target.id in self.nonlocal_names[-1])
               for target in node.targets)
        self.generic_visit(node)
        if escaped:
            node.value = ast.copy_location(ast.Call(func=ast.Name(id=self.escape_name, ctx=ast.Load()),
                args=[node.value], keywords=[]), node.value)
            self.changed = True
        return node

    def visit_Attribute(self, node: Any) -> Any:
        self.generic_visit(node)
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            # Keep private-name mangling in Python's original class scope.
            if node.attr.startswith("__") and not node.attr.endswith("__"):
                return node
            node.value = ast.copy_location(ast.Call(func=ast.Name(id=self.attribute_mutation_name, ctx=ast.Load()),
                args=[node.value, ast.Constant(value=node.attr)], keywords=[]), node.value)
            self.changed = True
        return node

    def visit_AugAssign(self, node: Any) -> Any:
        self.generic_visit(node)
        if isinstance(node.target, ast.Name) and isinstance(node.op, (ast.BitOr, ast.Add, ast.Mult)):
            boundary = ast.Expr(value=ast.Call(func=ast.Name(id=self.mutation_name, ctx=ast.Load()),
                args=[ast.Name(id=node.target.id, ctx=ast.Load())], keywords=[]))
            self.changed = True
            return [ast.copy_location(boundary, node), node]
        return node

    def visit_Call(self, node: Any) -> Any:
        self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id in self.names:
            return node
        if (isinstance(node.func, ast.Call) and isinstance(node.func.func, ast.Name)
                and node.func.func.id == _ProjectionTransformer.keyword_callable_name):
            return node
        self.changed = True
        if ((isinstance(node.func, ast.Name) and node.func.id in {
                "super", "locals", "globals", "vars", "eval", "exec", "dir", "compile"})
                or isinstance(node.func, ast.Attribute) and node.func.attr in {"currentframe", "stack", "_getframe"}):
            return ast.copy_location(ast.Call(func=ast.Name(id=self.boundary_name, ctx=ast.Load()),
                args=[node], keywords=[]), node)
        node.func = ast.copy_location(ast.Call(func=ast.Name(id=self.callable_name, ctx=ast.Load()),
            args=[node.func, ast.Constant(value=self.filename), ast.Constant(value=node.lineno)], keywords=[]), node.func)
        return node


class _ProjectionLoader(importlib.abc.Loader):
    def __init__(self, original: Any, registration: Any, filename: str) -> None:
        self.original, self.registration, self.filename = original, registration, filename

    def create_module(self, spec: Any) -> Any:
        return self.original.create_module(spec)

    def get_filename(self, fullname: str) -> str:
        return self.filename

    def get_source(self, fullname: str) -> Any:
        return self.original.get_source(fullname)

    def exec_module(self, module: Any) -> None:
        source = self.get_source(module.__name__)
        if source is None or len(source.encode("utf-8")) > _SOURCE_FILE_BYTES:
            return self.original.exec_module(module)
        tree = ast.parse(source, filename=self.filename)
        names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        names.update(name for node in ast.walk(tree) if isinstance(node, (ast.Global, ast.Nonlocal)) for name in node.names)
        if names.intersection(_DictionaryTransformer.names):
            return self.original.exec_module(module)
        transformer = _ProjectionTransformer(self.filename)
        tree = transformer.visit(tree)
        dictionaries = _DictionaryTransformer(self.filename)
        tree = dictionaries.visit(tree)
        if not transformer.changed and not dictionaries.changed:
            return self.original.exec_module(module)
        ast.fix_missing_locations(tree)
        registration = self.registration
        module.__dict__[transformer.construct_name] = lambda constructor, entries, filename, line: _dto_construct(
            registration, constructor, entries, filename, line)
        module.__dict__[transformer.attribute_name] = _dto_attribute
        module.__dict__[transformer.binary_name] = _dto_binary
        module.__dict__[transformer.constant_name] = _dto_constant
        module.__dict__[transformer.isoformat_name] = _dto_isoformat
        module.__dict__[transformer.keyword_callable_name] = lambda constructor, filename, line, column: _dto_keyword_callable(
            registration, constructor, filename, line, column)
        module.__dict__[transformer.keyword_mapping_name] = _dto_keyword_mapping
        module.__dict__[dictionaries.construct_name] = lambda entries, filename, line: _dictionary_construct(
            registration, entries, filename, line)
        module.__dict__[dictionaries.comprehension_name] = lambda make, filename, line: _dictionary_comprehension(
            registration, make, filename, line)
        module.__dict__[dictionaries.comp_value_name] = _dictionary_comp_value
        module.__dict__[dictionaries.row_iteration_name] = _row_iteration
        module.__dict__[dictionaries.row_pair_name] = _row_pair
        module.__dict__[dictionaries.row_choose_name] = _row_choose
        module.__dict__[dictionaries.list_iteration_name] = _collection_iteration
        module.__dict__[dictionaries.list_comprehension_name] = lambda make, filename, line: _collection_comprehension(
            registration, make, filename, line)
        module.__dict__[dictionaries.slice_name] = lambda source, lower, upper, step, filename, line: _collection_slice(
            registration, source, lower, upper, step, filename, line)
        module.__dict__[dictionaries.getattr_name] = _dictionary_getattr
        module.__dict__[dictionaries.callable_name] = lambda function, filename="", line=0: _dictionary_callable(registration, function, filename, line)
        module.__dict__[dictionaries.mutation_name] = _dictionary_invalidate
        module.__dict__[dictionaries.boundary_name] = _dictionary_boundary
        module.__dict__[dictionaries.attribute_mutation_name] = _projection_mutation
        module.__dict__[dictionaries.escape_name] = _projection_escape
        code = compile(tree, self.filename, "exec", dont_inherit=True)
        def remember(compiled: Any) -> None:
            key = id(compiled)
            _instrumented_codes[key] = (weakref.ref(compiled, lambda ref, key=key: _instrumented_codes.pop(key, None)),
                                        weakref.ref(registration))
            for constant in compiled.co_consts:
                if isinstance(constant, types.CodeType):
                    remember(constant)
        remember(code)
        exec(code, module.__dict__)


class _ProjectionFinder(importlib.abc.MetaPathFinder):
    def __init__(self, root: Path, include: tuple[Path, ...]) -> None:
        self.root, self.include, self.active = root, include, True

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if not self.active:
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if spec is None or not isinstance(spec.loader, importlib.machinery.SourceFileLoader):
            return None
        filename = spec.loader.get_filename(fullname)
        safe = _source_path(self.root, filename)
        if safe is None or not any(safe[0].is_relative_to(directory) for directory in self.include):
            return None
        spec.loader = _ProjectionLoader(spec.loader, self, str(safe[0]))
        return spec


def instrument_project(root: str | Path, *, include: list[str] | tuple[str, ...] = (".",)) -> Callable[[], None]:
    """Observe direct ORM-attribute projections in future project imports.

    Install before importing application modules, then enable response_models
    in setup(). Original files are never edited and application values retain
    their types. Direct dictionary entries, getattr comprehensions, tracked
    dictionary **kwargs into plain DTOs, and no-argument date.isoformat calls
    retain actual executed dependencies. Exact UUID/date/datetime and standard
    Enum values have controlled JSON serialization guards. Explicit keywords
    such as DTO(label=row.title) and
    FrozenDTO(total=row.price * row.quantity) are candidates. Numeric +, -, *, /
    over loaded ORM fields and literals require a frozen Pydantic DTO with its
    standard assignment behavior. Plain dict calculations, arbitrary calls,
    custom numeric types and positional projections are not inferred. Mutation
    and unknown escapes discard optional provenance without wrapping values.
    Detach removes the import hook and disables captured helpers.
    """
    root = Path(root).resolve()
    if not root.is_dir() or not isinstance(include, (list, tuple)) or not 1 <= len(include) <= 64:
        raise ValueError("Choose an existing repository and one to 64 relative source directories")
    directories = []
    for name in include:
        if not isinstance(name, str) or not name or Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError("Projection source directories must stay inside the repository")
        directory = (root / name).resolve()
        if not directory.is_relative_to(root) or not directory.is_dir():
            raise ValueError("Projection source directory is unavailable or outside the repository")
        directories.append(directory)
    _source_baseline(root)
    finder = _ProjectionFinder(root, tuple(directories))
    position = next((index for index, entry in enumerate(sys.meta_path)
                     if entry is importlib.machinery.PathFinder), len(sys.meta_path))
    sys.meta_path.insert(position, finder)
    closed = False

    def detach() -> None:
        nonlocal closed
        if not closed:
            closed = True
            finder.active = False
            if finder in sys.meta_path:
                sys.meta_path.remove(finder)

    return detach


def _publish_dictionary_entry(trace: Trace, source: Any, key: Any, encoded: Any, path: str) -> bool:
    if type(source) is not dict or not _dictionary_key(key) or len(trace.fields) >= _RESPONSE_FIELDS:
        return False
    entry = trace.dictionary_origins.get(id(source))
    captured = entry[1].get(key) if entry and entry[0] is source else None
    if not captured or key not in source:
        return False
    projection = captured["origin"]["projection"]
    if (len(path) <= 200
            and trace.site(str(trace.root / projection["path"]), projection["line"], projection["name"]) == projection
            and _serialized_same(trace, source[key], encoded, captured["fingerprint"])):
        trace.fields[path] = captured["origin"]
        return True
    return False


def _capture_dictionary_response(trace: Trace, raw: Any, output: Any) -> None:
    if isinstance(output, (bytes, bytearray, str)):
        if len(output) > 2 * 1024 * 1024:
            return
        output = json.loads(output)
    budget, active = [12000], set()

    def walk(source: Any, encoded: Any, path: str, depth: int = 0) -> None:
        if budget[0] <= 0 or depth > 8 or id(source) in active or len(path) > 200:
            return
        budget[0] -= 1
        if type(source) is dict and type(encoded) is dict:
            active.add(id(source))
            try:
                for key, value in source.items():
                    output_key = _dictionary_output_key(key)
                    if output_key is not None and output_key in encoded:
                        child = f"{path}.{output_key}" if path else output_key
                        if not _publish_dictionary_entry(trace, source, key, encoded[output_key], child):
                            walk(value, encoded[output_key], child, depth + 1)
            finally:
                active.remove(id(source))
        elif type(source) in (list, tuple) and type(encoded) is list and len(source) == len(encoded):
            _publish_collection(trace, source, encoded, path)
            active.add(id(source))
            try:
                for index, value in enumerate(source):
                    walk(value, encoded[index], f"{path}.{index}" if path else str(index), depth + 1)
            finally:
                active.remove(id(source))

    walk(raw, output, "")


def _capture_response_model(trace: Trace, field: Any, raw: Any, output: Any,
                            *, by_alias: bool) -> None:
    """Map structure and declared aliases, never search for equal JSON values.

    Plain Pydantic v2 models need direct ORM inputs or instrumented constructor
    metadata. Uninstrumented DTOs and custom transformations cannot qualify.
    """
    from pydantic import BaseModel
    from sqlalchemy import inspect as orm_inspect
    from sqlalchemy.orm.attributes import NO_VALUE

    if field is None:
        _capture_dictionary_response(trace, raw, output)
        return
    adapter = getattr(field, "_type_adapter", None)
    schema = getattr(adapter, "core_schema", None)
    annotation = getattr(getattr(field, "field_info", None), "annotation", None)
    if not schema or not _safe_response_schema(schema, allow_computed=True):
        return
    if isinstance(output, (bytes, bytearray, str)):
        if len(output) > 300000:
            return
        output = json.loads(output)
    budget = 12000

    def orm_state(value: Any) -> Any:
        try:
            state = orm_inspect(value, raiseerr=False)
            return state if state is not None and hasattr(state, "mapper") else None
        except Exception:
            return None

    def walk(kind: Any, source: Any, encoded: Any, path: str, depth: int = 0) -> None:
        nonlocal budget
        budget -= 1
        if budget < 0 or depth > 8 or len(path) > 200:
            return
        origin, arguments = get_origin(kind), get_args(kind)
        if origin is Annotated:
            return walk(arguments[0], source, encoded, path, depth + 1)
        if origin in (Union, types.UnionType):
            choices = [choice for choice in arguments if choice is not type(None)]
            if len(choices) == 1 and source is not None:
                walk(choices[0], source, encoded, path, depth + 1)
            return
        if origin is list:
            if type(source) is list and type(encoded) is list and len(source) == len(encoded):
                _publish_collection(trace, source, encoded, path)
                for index, value in enumerate(source):
                    walk(arguments[0], value, encoded[index], f"{path}.{index}" if path else str(index), depth + 1)
            return
        if origin is dict:
            if arguments and arguments[0] in (str, uuid.UUID) and type(source) is dict and type(encoded) is dict:
                for key, value in source.items():
                    output_key = _dictionary_output_key(key) if type(key) is arguments[0] else None
                    if output_key is not None and output_key in encoded:
                        child_path = f"{path}.{output_key}" if path else output_key
                        if not _publish_dictionary_entry(trace, source, key, encoded[output_key], child_path):
                            walk(arguments[1], value, encoded[output_key], child_path, depth + 1)
            return
        if not isinstance(kind, type) or not issubclass(kind, BaseModel) or type(encoded) is not dict:
            return
        dto = isinstance(source, BaseModel)
        if dto and (type(source) is not kind or type(source).__getattribute__ is not object.__getattribute__):
            return
        state = None if dto or type(source) is dict else orm_state(source)
        if state is None and type(source) is not dict and not dto:
            return
        config = kind.model_config
        if state is not None and not config.get("from_attributes"):
            return
        if state is not None and not _plain_orm_access(type(source)):
            return  # Custom attribute access is an application transformation.
        decorators = getattr(kind, "__pydantic_decorators__", None)
        if decorators and any(getattr(decorators, name, None) for name in (
                "validators", "field_validators", "root_validators", "field_serializers",
                "model_serializers", "model_validators")):
            return
        if (getattr(kind, "__pydantic_computed_fields__", None)
                or getattr(decorators, "computed_fields", None)) and not (
                dto and id(source) in trace.dto_origins):
            return
        fields = kind.model_fields
        output_names = [(item.serialization_alias or item.alias or name) if by_alias else name
                        for name, item in fields.items()]
        if len(output_names) != len(set(output_names)):
            return
        for (name, item), output_name in zip(fields.items(), output_names):
            if output_name not in encoded or not isinstance(output_name, str):
                continue
            child_path = f"{path}.{output_name}" if path else output_name
            if any(part in {"__proto__", "constructor", "prototype"} for part in child_path.split('.')):
                continue
            if dto:
                values = object.__getattribute__(source, "__dict__")
                if name not in values:
                    continue
                value = values[name]
                entry = trace.dto_origins.get(id(source))
                captured = entry[1].get(name) if entry and entry[0]() is source else None
                if captured and len(trace.fields) < _RESPONSE_FIELDS:
                    projection = captured["origin"]["projection"]
                    current_site = trace.site(str(trace.root / projection["path"]),
                                              projection["line"], projection["name"])
                    if (current_site == projection
                            and _serialized_same(trace, value, encoded[output_name], captured["fingerprint"])):
                        trace.fields[child_path] = captured["origin"]
                        continue
                # Uninstrumented envelopes can contain instrumented DTOs;
                # primitive values still acquire no origin from equality.
                walk(item.annotation, value, encoded[output_name], child_path, depth + 1)
                continue
            alias = item.validation_alias if item.validation_alias is not None else item.alias
            if alias is not None and not isinstance(alias, str):
                continue  # AliasPath and AliasChoices are not direct attributes.
            use_alias = config.get("validate_by_alias", True)
            candidates = [alias] if alias is not None and use_alias else [name]
            if alias is not None and use_alias and (config.get("populate_by_name") or config.get("validate_by_name")):
                candidates.append(name)
            source_name = None
            missing = object()
            for candidate in candidates:
                present = candidate in source if type(source) is dict else candidate in state.attrs
                if present:
                    source_name = candidate
                    break
                if state is not None and inspect.getattr_static(source, candidate, missing) is not missing:
                    # A property with the alias wins over the name fallback in
                    # Pydantic. It must not be mistaken for the mapped column.
                    break
            if source_name is None:
                continue
            if state is None:
                if not _publish_dictionary_entry(trace, source, source_name, encoded[output_name], child_path):
                    walk(item.annotation, source[source_name], encoded[output_name], child_path, depth + 1)
                continue
            attribute = state.attrs[source_name]
            value = attribute.loaded_value
            if value is NO_VALUE or attribute.history.has_changes():
                continue
            if (source_name in state.mapper.column_attrs
                    and _immutable_value(value)
                    and _serialized_same(trace, value, encoded[output_name], _dto_fingerprint(trace, value))):
                # Equality only checks that this already structurally mapped
                # attribute survived serialization; it never chooses an origin.
                response_field(child_path, source, source_name)
            else:
                walk(item.annotation, value, encoded[output_name], child_path, depth + 1)

    walk(annotation, raw, output, "")


def _attach_response_models() -> tuple[object, Callable[[], None]]:
    """Share one FastAPI hook; tokens restrict it to opted-in application traces."""
    import fastapi.routing as routing
    global _response_hook_state
    token = object()
    with _response_hook_lock:
        state = _response_hook_state
        if state is None or routing.serialize_response is not state["wrapper"]:
            original = routing.serialize_response
            state = {"original": original, "tokens": set()}

            async def wrapped(*args: Any, **kwargs: Any) -> Any:
                result = await original(*args, **kwargs)
                trace = _current.get()
                if (trace and not trace.closed
                        and trace._response_model_token in state["tokens"]):
                    try:
                        _capture_response_model(trace, kwargs.get("field"),
                                                kwargs.get("response_content"), result,
                                                by_alias=kwargs.get("by_alias", True))
                    except Exception:
                        pass  # An optional observer cannot change the response.
                return result

            state["wrapper"] = wrapped
            routing.serialize_response = wrapped
            _response_hook_state = state
        state["tokens"].add(token)
    closed = False

    def detach() -> None:
        nonlocal closed
        global _response_hook_state
        with _response_hook_lock:
            if closed:
                return
            closed = True
            state["tokens"].discard(token)
            if not state["tokens"]:
                if routing.serialize_response is state["wrapper"]:
                    routing.serialize_response = state["original"]
                if _response_hook_state is state:
                    _response_hook_state = None

    return token, detach


def active() -> bool:
    return _current.get() is not None


class PostgresResult:
    """Fetched psycopg result; direct fields use server-reported column OIDs."""
    def __init__(self, rows: list[Any], description: Any, trace: Trace | None,
                 query: dict[str, Any] | None, origins: dict[int, Any]) -> None:
        self.rows = rows
        self.description = description or []
        self.trace, self.query, self.origins = trace, query, origins
        self.names = [column.name for column in self.description]
        self.originals = [tuple(row[name] for name in self.names) if isinstance(row, dict)
                          else tuple(row) for row in rows]

    def field(self, row: int, column: str, path: str) -> Any:
        if not isinstance(row, int) or row < 0 or row >= len(self.rows) or self.names.count(column) != 1:
            raise ValueError("Choose an unambiguous returned result column and row")
        index = self.names.index(column)
        value = self.rows[row][column] if isinstance(self.rows[row], dict) else self.rows[row][index]
        origin = self.origins.get(index)
        if (self.trace and not self.trace.closed and self.query and origin
                and value == self.originals[row][index] and isinstance(path, str)
                and len(path) <= 200 and not any(part in {"__proto__", "constructor", "prototype"} for part in path.split('.'))
                and len(self.trace.fields) < _RESPONSE_FIELDS):
            self.trace.fields[path] = dict(table=origin[0], column=origin[1], model=None,
                                          queries=[self.query['id']])
        return value


def read_postgres(cursor: Any, statement: str, parameters: Any = ()) -> PostgresResult:
    """Execute/fetch with psycopg 2 or 3; computed/ambiguous columns have no origin.

    When tracing is active, a bounded pg_catalog lookup resolves server result
    table/column identifiers. A savepoint isolates optional metadata failures in
    a transaction. Without a trace, no catalog query is executed.
    """
    trace = _current.get()
    previous = trace.last_query if trace else None
    if trace:
        trace.execute(cursor, statement, parameters)
    else:
        cursor.execute(statement, parameters)
    rows, description = cursor.fetchall(), cursor.description
    query = trace.last_query if trace and trace.last_query is not previous else None
    origins = {}
    if trace and query:
        try:
            pgresult = getattr(cursor, 'pgresult', None)
            pairs = [(pgresult.ftable(i), pgresult.ftablecol(i)) if pgresult is not None
                     else (getattr(column, 'table_oid', None), getattr(column, 'table_column', None))
                     for i, column in enumerate(description or [])]
            oids = sorted({oid for oid, number in pairs if oid and number})[:200]
            if oids:
                connection = cursor.connection
                savepoint = 'studio_metadata_' + uuid.uuid4().hex
                transactional = not connection.autocommit
                with connection.cursor() as metadata:
                    if transactional:
                        metadata.execute('SAVEPOINT ' + savepoint)
                    try:
                        metadata.execute("SELECT a.attrelid, a.attnum, n.nspname || '.' || c.relname, a.attname "
                                         "FROM pg_catalog.pg_attribute a "
                                         "JOIN pg_catalog.pg_class c ON c.oid = a.attrelid "
                                         "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
                                         "WHERE a.attrelid = ANY(%s) AND a.attnum > 0 AND NOT a.attisdropped", (oids,))
                        found = {(record[0], record[1]): (record[2], record[3]) for record in metadata.fetchall()}
                        origins = {i: found[pair] for i, pair in enumerate(pairs) if pair in found}
                    except Exception:
                        if transactional:
                            metadata.execute('ROLLBACK TO SAVEPOINT ' + savepoint)
                    finally:
                        if transactional:
                            metadata.execute('RELEASE SAVEPOINT ' + savepoint)
                query['tables'] = sorted({origin[0] for origin in origins.values()})[:20]
        except Exception:
            pass  # Optional metadata cannot replace successful application data.
    return PostgresResult(rows, description, trace, query, origins)


def serialize(instance: Any, fields: dict[str, str], *, path: str) -> dict[str, Any]:
    """Return direct attribute values and publish supported field origins together.

    Output keys map to ORM attribute names. Computed/modified attributes keep
    their application value but cannot be presented as an unchanged DB column.
    Use one explicit response path per item, e.g. items.0; no value matching.
    """
    output = {}
    for output_name, attribute in fields.items():
        value = getattr(instance, attribute)
        output[output_name] = value
        response_field(f"{path}.{output_name}" if path else output_name, instance, attribute)
    return output


def setup(app: FastAPI, root: str | Path, *, development: bool = False,
          engine: Any = None, sessions: Any = None,
          response_models: bool = False,
          exclude: tuple[str, ...] = ("/auth", "/api/auth", "/api/v1/auth"),
          publish_trace: Callable[[dict[str, Any]], str | None] | None = None) -> Callable[[], None]:
    """Configure an app once; call detach from its shutdown lifecycle.

    response_models=True observes plain Pydantic v2 response models and direct
    dictionary serializers instrumented before import. Custom serializers,
    validators and unsupported computations never inherit guessed origins.
    publish_trace is an optional managed-host transport for complete metadata
    that cannot fit the bounded header; fitting traces remain inline.
    """
    if not development:
        return lambda: None
    if not isinstance(response_models, bool):
        raise TypeError("response_models must be true or false")
    detach = []
    response_model_token = None
    try:
        if engine is not None:
            detach.append(attach_sqlalchemy(engine))
        if sessions is not None:
            detach.append(attach_orm(sessions))
        if response_models:
            response_model_token, remove = _attach_response_models()
            detach.append(remove)
        middleware(app, root, development=True, exclude=exclude,
                   _response_model_token=response_model_token, publish_trace=publish_trace)
    except Exception:
        for remove in reversed(detach):
            remove()
        raise
    closed = False
    def close() -> None:
        nonlocal closed
        if not closed:
            closed = True
            for remove in reversed(detach):
                remove()
    return close
