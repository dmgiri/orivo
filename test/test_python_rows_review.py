"""Independent native-processor regressions for optional scalar-row evidence."""
import unittest
import uuid
import types
from functools import partial

import test_python_rows as row_fixture
from sqlalchemy import event
from sqlalchemy.engine import Row


EXTRA_SOURCE = '''
def processor_changed_after_execute(session):
    result=session.execute(select(User.id,User.name).order_by(User.id))
    result.raw._metadata._processors[1]=replacement_processor
    return {identifier:name or 'Member' for identifier,name in result}
def uuid_value(session):
    return {label:identifier for label,identifier in session.execute(select(User.duplicate,User.id).order_by(User.id))}
'''


class RowSafetyReviewTests(unittest.TestCase):
    def setUp(self):
        original = row_fixture.SOURCE
        row_fixture.SOURCE = original + EXTRA_SOURCE
        try:
            self.fixture = row_fixture.RowTests(methodName="test_direct_tuple_unpack_and_actual_or_branch")
            self.fixture.setUp()
        finally:
            row_fixture.SOURCE = original

    def tearDown(self):
        self.fixture.tearDown()

    def assert_changed_native_response(self, response):
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            str(uuid.UUID(int=1)): "processed",
            str(uuid.UUID(int=2)): "Member",
        })
        trace = row_fixture.decode(response)
        self.assertTrue(trace["queries"])
        self.assertEqual(trace["fields"], {})

    def test_mutating_native_processor_vector_after_execute_drops_optional_origin(self):
        self.fixture.project.replacement_processor = lambda value: "processed" if value else value
        with self.fixture.configure("processor_changed_after_execute") as client:
            self.assert_changed_native_response(self.fixture.request(client))

    def test_module_spoofed_processor_keeps_native_values_without_column_claim(self):
        with self.fixture.configure() as client:
            native_results = []

            def downstream_execution(state):
                result = state.invoke_statement()
                processor = lambda value: "processed" if value else value
                processor.__module__ = "sqlalchemy.sql.sqltypes"
                processor.__name__ = "process"
                result.raw._metadata._processors[1] = processor
                native_results.append(result)
                return result

            event.listen(self.fixture.Session, "do_orm_execute", downstream_execution)
            try:
                self.assert_changed_native_response(self.fixture.request(client))
            finally:
                event.remove(self.fixture.Session, "do_orm_execute", downstream_execution)
            self.assertEqual(len(native_results), 1)
            self.assertEqual(type(native_results[0]).__name__, "ChunkedIteratorResult")

    def test_copied_native_processor_code_with_replaced_globals_is_untrusted(self):
        replacement = uuid.UUID(int=999)
        with self.fixture.configure("uuid_value") as client:
            def downstream_execution(state):
                result = state.invoke_statement()
                original = result.raw._metadata._processors[1]
                self.assertIsInstance(original, types.FunctionType)
                globals_copy = dict(original.__globals__)
                globals_copy["_python_UUID"] = lambda value: replacement
                copied = types.FunctionType(original.__code__, globals_copy,
                                            original.__name__, original.__defaults__, original.__closure__)
                self.assertIs(copied.__code__, original.__code__)
                result.raw._metadata._processors[1] = copied
                return result

            event.listen(self.fixture.Session, "do_orm_execute", downstream_execution)
            try:
                response = self.fixture.request(client)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"equal": str(replacement)})
                trace = row_fixture.decode(response)
                self.assertTrue(trace["queries"])
                self.assertEqual(trace["fields"], {})
            finally:
                event.remove(self.fixture.Session, "do_orm_execute", downstream_execution)

    def test_native_row_constructor_with_non_native_getter_processors_is_untrusted(self):
        with self.fixture.configure() as client:
            def downstream_execution(state):
                result = state.invoke_statement()
                metadata = result._metadata
                processor = lambda value: "processed" if value else value
                result._row_getter = partial(Row, metadata, [None, processor], metadata._key_to_index)
                return result

            event.listen(self.fixture.Session, "do_orm_execute", downstream_execution)
            try:
                self.assert_changed_native_response(self.fixture.request(client))
            finally:
                event.remove(self.fixture.Session, "do_orm_execute", downstream_execution)


if __name__ == "__main__":
    unittest.main()
