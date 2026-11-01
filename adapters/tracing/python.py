"""Compatibility entry point; prefer the installable studio_tracing module."""
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path
_spec = spec_from_file_location("_studio_tracing_impl", Path(__file__).with_name("studio_tracing.py"))
_module = module_from_spec(_spec)
_spec.loader.exec_module(_module)
for _name in ("Trace", "capture", "middleware", "attach_sqlalchemy", "attach_orm", "response_field", "serialize", "setup", "active", "read_postgres", "PostgresResult"):
    globals()[_name] = getattr(_module, _name)
