"""Independent native Result integrity checks for collection witnesses."""
import itertools
import unittest

import test_python_collections as collection_fixture
from sqlalchemy import event, select


EXTRA_SOURCE = '''
def replaced_allrows(session):
    result=session.scalars(select(Item).order_by(Item.id))
    result._allrows=replacement_allrows
    return result.all()
'''


class CollectionSafetyReviewTests(unittest.TestCase):
    def setUp(self):
        original = collection_fixture.SOURCE
        collection_fixture.SOURCE = original + EXTRA_SOURCE
        try:
            self.fixture = collection_fixture.CollectionTests(methodName="test_actual_native_scalar_all_list_and_empty_list")
            self.fixture.setUp()
        finally:
            collection_fixture.SOURCE = original

    def tearDown(self):
        self.fixture.tearDown()

    def assert_native_output_without_witness(self, response, expected_count):
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), expected_count)
        trace = collection_fixture.decode(response)
        self.assertTrue(trace["queries"])
        self.assertEqual(trace["collections"], {})

    def test_native_all_control_records_actual_membership(self):
        with self.fixture.configure("direct", list[self.fixture.project.View]) as client:
            response = self.fixture.request(client)
            self.assertEqual(len(response.json()), 3)
            self.fixture.assert_collection(collection_fixture.decode(response), "", 3)

    def test_custom_chunks_callback_keeps_native_response_without_membership_claim(self):
        fake = self.fixture.project.Item(id=999, name="Synthetic replacement")
        with self.fixture.configure("direct", list[self.fixture.project.View]) as client:
            def downstream_execution(state):
                result = state.invoke_statement()
                result.chunks = lambda size: iter(([fake],))
                result.iterator = itertools.chain.from_iterable(result.chunks(None))
                return result

            event.listen(self.fixture.Session, "do_orm_execute", downstream_execution)
            try:
                response = self.fixture.request(client)
                self.assert_native_output_without_witness(response, 1)
                self.assertEqual(response.json()[0]["id"], 999)
            finally:
                event.remove(self.fixture.Session, "do_orm_execute", downstream_execution)

    def test_native_generator_from_another_execution_cannot_borrow_query_identity(self):
        active = False
        foreign_results = []
        with self.fixture.configure("direct", list[self.fixture.project.View]) as client:
            def downstream_execution(state):
                nonlocal active
                result = state.invoke_statement()
                if active:
                    return result
                active = True
                try:
                    other = state.session.execute(select(self.fixture.project.Item).where(self.fixture.project.Item.id == 1))
                    foreign_results.append(other)
                    result.iterator = other.iterator
                finally:
                    active = False
                return result

            event.listen(self.fixture.Session, "do_orm_execute", downstream_execution)
            try:
                response = self.fixture.request(client)
                self.assert_native_output_without_witness(response, 1)
                self.assertEqual(response.json()[0]["id"], 1)
                self.assertEqual(len(foreign_results), 1)
            finally:
                event.remove(self.fixture.Session, "do_orm_execute", downstream_execution)

    def test_custom_fetchall_method_does_not_inherit_native_all_claim(self):
        fake = self.fixture.project.Item(id=999, name="Synthetic replacement")
        with self.fixture.configure("direct", list[self.fixture.project.View]) as client:
            def downstream_execution(state):
                result = state.invoke_statement()
                result._fetchall_impl = lambda: [fake]
                return result

            event.listen(self.fixture.Session, "do_orm_execute", downstream_execution)
            try:
                response = self.fixture.request(client)
                self.assert_native_output_without_witness(response, 1)
                self.assertEqual(response.json()[0]["id"], 999)
            finally:
                event.remove(self.fixture.Session, "do_orm_execute", downstream_execution)

    def test_scalar_allrows_override_preserves_output_and_discards_optional_witness(self):
        fake = self.fixture.project.Item(id=999, name="Synthetic replacement")
        self.fixture.project.replacement_allrows = lambda: [fake]
        with self.fixture.configure("replaced_allrows", list[self.fixture.project.View]) as client:
            response = self.fixture.request(client)
            self.assert_native_output_without_witness(response, 1)
            self.assertEqual(response.json()[0]["id"], 999)


if __name__ == "__main__":
    unittest.main()
