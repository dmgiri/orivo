import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
module_path = Path(__file__).resolve().parents[1] / 'adapters/tracing/managed_trace_store.py'
spec = importlib.util.spec_from_file_location('anvaya_memory_store', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManagedTraceStoreTests(unittest.TestCase):
    def test_complete_trace_retained_with_opaque_keys_and_no_application_values(self):
        store = module.ManagedTraceStore()
        payload = {'id': 'request_12345', 'queries': [{'id': 'q' + str(i), 'sql': 'SELECT body FROM messages'} for i in range(256)], 'fields': {'items.19.body': {'table': 'messages', 'column': 'body', 'queries': ['q255']}}}
        key = store.publish(payload)
        self.assertRegex(key, r'^[a-f0-9]{32}$')
        self.assertEqual(json.loads(store.get(key)), payload)
        self.assertIsNone(store.get('../' + key))
        self.assertIsNone(store.get('b' * 32))
        store.close()
        self.assertIsNone(store.get(key))

    def test_bounds_eviction_expiry_and_invalid_payloads(self):
        store = module.ManagedTraceStore()
        first = store.publish({'id': 'request_12345'})
        for i in range(store.MAX_TRACES):
            store.publish({'id': 'request_' + str(i).zfill(8)})
        self.assertIsNone(store.get(first))
        latest = store.publish({'id': 'request_latest'})
        with patch.object(module.time, 'monotonic', return_value=module.time.monotonic() + 91):
            self.assertIsNone(store.get(latest))
        self.assertIsNone(store.publish({'id': 'invalid'}))
        self.assertIsNone(store.publish({'id': 'request_large', 'value': 'x' * store.MAX_TRACE_BYTES}))
        self.assertIsNone(store.publish({'id': 'request_nan', 'value': float('nan')}))
        self.assertEqual(store._bytes, 0)


if __name__ == '__main__':
    unittest.main()
