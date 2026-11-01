"""Async SQLAlchemy runs cursor hooks in a child greenlet."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'adapters' / 'tracing'))
import studio_tracing as studio


class GreenletStackTests(unittest.TestCase):
    def test_query_site_follows_actual_greenlet_parent_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'service.py'
            source.write_text('from greenlet import greenlet\n'
                              'def execute(trace):\n'
                              '    return greenlet(trace.capture).switch("SELECT title FROM items")\n', encoding='utf-8')
            spec = importlib.util.spec_from_file_location('greenlet_service', source)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            trace = studio.Trace(Path(directory), 'greenlet_trace_12345')
            query = module.execute(trace)
            self.assertTrue(query['frames'])
            self.assertEqual(query['site']['path'], 'service.py')
