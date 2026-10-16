import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

SOURCE = os.environ.get('HERMES_TEST_SOURCE')
if SOURCE:
    sys.path.insert(0, SOURCE)
spec = importlib.util.spec_from_file_location('provider_rewind_hermes', Path(__file__).with_name('provider-rewind-hermes.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

@unittest.skipUnless(SOURCE, 'Set HERMES_TEST_SOURCE and use the verified Hermes Python runtime')
class NativeHermesBranchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='terminal-v4-hermes-rewind-')
        self.addCleanup(self.directory.cleanup)
        self.workspace = Path(self.directory.name).resolve()
        self.database = self.workspace / 'state.db'
        from hermes_state import SessionDB
        self.db = SessionDB(self.database)
        self.addCleanup(self.db.close)
        self.session = '20260101_000000_abcdef'
        self.db.create_session(self.session, 'cli', cwd=str(self.workspace), model='test', model_config={'reasoning_config': {'effort':'low'}})
        self.db.append_messages_batch(self.session, [{'role':'user','content':'first'}, {'role':'assistant','content':'reply'}, {'role':'user','content':'second'}, {'role':'assistant','content':'later'}])

    def request(self, operation, **extra):
        return dict(operation=operation, workspace=str(self.workspace), database=str(self.database), **extra)

    def test_native_branch_preserves_exact_prefix_and_original_history(self):
        original = self.db.get_messages_as_conversation(self.session)
        row = helper.run(self.request('list'))[0]
        fork = helper.run(self.request('fork',sessionId=self.session,targetTurnId=row['turns'][1]['id'],fingerprint=row['fingerprint']))
        self.assertNotEqual(fork['sessionId'], self.session)
        messages = self.db.get_messages_as_conversation(fork['sessionId'], include_ancestors=True)
        self.assertEqual([(m['role'],m['content']) for m in messages], [('user','first'),('assistant','reply')])
        self.assertEqual(self.db.get_messages_as_conversation(self.session),original)

    def test_first_turn_creates_empty_resumable_native_branch(self):
        row = helper.run(self.request('list'))[0]
        fork = helper.run(self.request('fork',sessionId=self.session,targetTurnId=row['turns'][0]['id'],fingerprint=row['fingerprint']))
        self.assertEqual(self.db.get_messages_as_conversation(fork['sessionId'],include_ancestors=True), [])
        self.assertEqual(self.db.get_session(fork['sessionId'])['parent_session_id'], self.session)

    def test_native_head_drift_refuses_fork(self):
        row = helper.run(self.request('list'))[0]
        self.db.append_messages_batch(self.session,[{'role':'user','content':'newer'}])
        with self.assertRaisesRegex(ValueError,'changed'):
            helper.run(self.request('fork',sessionId=self.session,targetTurnId=row['turns'][1]['id'],fingerprint=row['fingerprint']))

if __name__ == '__main__':
    unittest.main()
