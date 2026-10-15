import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from ytwhisper.auth import InvalidPairingCode, PairingManager


class PairingManagerTests(unittest.TestCase):
    def test_credentials_persist_only_the_hash_and_reject_an_unrelated_token(self):
        # Catches persisting the bearer secret or accepting arbitrary bearer tokens.
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token.json"
            manager = PairingManager(token_file, pairing_code="123456")
            token = manager.pair("123456")
            payload = json.loads(token_file.read_text())

            self.assertNotIn(token, token_file.read_text())
            self.assertEqual(payload, {"tokenHash": hashlib.sha256(token.encode()).hexdigest()})
            self.assertFalse(manager.verify("unrelated-token"))
            self.assertFalse(manager.verify(""))
            self.assertIsNone(manager.pairing_code)
            self.assertFalse(manager.pairing_required)

    def test_pairing_code_is_one_time_and_token_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token.json"
            manager = PairingManager(token_file, pairing_code="123456")

            token = manager.pair("123456")

            self.assertTrue(manager.verify(token))
            with self.assertRaises(InvalidPairingCode):
                manager.pair("123456")
            self.assertTrue(PairingManager(token_file).verify(token))

    def test_wrong_pairing_code_does_not_create_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token.json"
            manager = PairingManager(token_file, pairing_code="123456")

            with self.assertRaises(InvalidPairingCode):
                manager.pair("000000")

            self.assertFalse(token_file.exists())

