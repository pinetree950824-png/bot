import asyncio
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from nio import (
    AsyncClient,
    AsyncClientConfig,
    MatrixRoom,
    MegolmEvent,
    RoomKeyEvent,
    RoomMessageText,
    SyncError,
)

from bot import IntegratedBot
from config import Config


class TestMatrixE2eeChat(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="test_nio_store_")
        self.config = Config()
        self.config.CRYPTO_STORE_DIR = Path(self.temp_dir)
        self.config.MATRIX_DEVICE_ID = "TEST_DEVICE_001"
        self.config.MATRIX_HOMESERVER = "https://matrix.org"
        self.config.MATRIX_USER_ID = "@testbot:matrix.org"
        self.config.MATRIX_ACCESS_TOKEN = "test_token_secret"

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    async def test_bot_initialization_with_e2ee(self):
        bot = IntegratedBot(self.config)
        self.assertIsNotNone(bot.client.olm, "Olm crypto machine must be initialized")
        self.assertEqual(bot.client.device_id, "TEST_DEVICE_001")
        self.assertTrue(bot.client.should_upload_keys)
        self.assertTrue(bot.client.config.encryption_enabled)
        self.assertTrue(bot.client.config.store_sync_tokens)

        # Verify persistent database file exists on disk
        safe_user = "testbot_matrix.org"
        expected_db = Path(self.temp_dir) / f"{safe_user}_TEST_DEVICE_001.db"
        self.assertTrue(expected_db.exists(), f"SQLite DB should exist at {expected_db}")
        self.assertGreater(expected_db.stat().st_size, 0)

    async def test_store_persistence_across_restart(self):
        # First session
        bot1 = IntegratedBot(self.config)
        olm1_account = bot1.client.olm.account
        identity_keys_1 = olm1_account.identity_keys

        # Second session reusing the same store
        bot2 = IntegratedBot(self.config)
        olm2_account = bot2.client.olm.account
        identity_keys_2 = olm2_account.identity_keys

        self.assertEqual(
            identity_keys_1,
            identity_keys_2,
            "Reusing same store_path must preserve device identity keys",
        )

    async def test_send_message_uses_ignore_unverified_devices(self):
        bot = IntegratedBot(self.config)
        bot.client.room_send = AsyncMock(return_value=MagicMock(event_id="$evt123"))

        await bot._send_message_now("!room:matrix.org", "Hello E2EE")

        bot.client.room_send.assert_awaited_once_with(
            "!room:matrix.org",
            message_type="m.room.message",
            content={"msgtype": "m.text", "body": "Hello E2EE"},
            ignore_unverified_devices=True,
        )

    async def test_on_message_ignores_own_messages(self):
        bot = IntegratedBot(self.config)
        bot.first_sync_done = True
        bot.handle_command = AsyncMock()

        room = MatrixRoom(room_id="!room:matrix.org", own_user_id=self.config.MATRIX_USER_ID)
        event = RoomMessageText.from_dict({
            "type": "m.room.message",
            "sender": self.config.MATRIX_USER_ID,
            "content": {"msgtype": "m.text", "body": "!play test"},
            "origin_server_ts": 12345,
            "event_id": "$evt_own",
        })

        await bot.on_message(room, event)
        bot.handle_command.assert_not_called()

    async def test_on_message_processes_valid_command(self):
        bot = IntegratedBot(self.config)
        bot.first_sync_done = True
        bot.handle_command = AsyncMock()

        room = MatrixRoom(room_id="!room:matrix.org", own_user_id=self.config.MATRIX_USER_ID)
        event = RoomMessageText.from_dict({
            "type": "m.room.message",
            "sender": "@user:matrix.org",
            "content": {"msgtype": "m.text", "body": "!queue"},
            "origin_server_ts": 12345,
            "event_id": "$evt_user",
        })

        await bot.on_message(room, event)
        bot.handle_command.assert_awaited_once_with(room, "!queue", sender="@user:matrix.org")

    async def test_megolm_buffering_and_key_retry(self):
        bot = IntegratedBot(self.config)
        bot.first_sync_done = True
        bot.on_message = AsyncMock()

        room = MatrixRoom(room_id="!room:matrix.org", own_user_id=self.config.MATRIX_USER_ID)

        # Mock undecrypted MegolmEvent
        megolm_event = MagicMock(spec=MegolmEvent)
        megolm_event.event_id = "$megolm_001"
        megolm_event.sender = "@alice:matrix.org"

        # Initially, decrypt_event raises an exception (key missing)
        bot.client.decrypt_event = MagicMock(side_effect=Exception("No session key"))

        await bot.on_megolm_event(room, megolm_event)

        # Event should be buffered in pending
        self.assertIn("$megolm_001", bot._pending_megolm_events)
        bot.on_message.assert_not_called()

        # Now simulate key arrival: decrypt_event succeeds with RoomMessageText
        decrypted_msg = RoomMessageText.from_dict({
            "type": "m.room.message",
            "sender": "@alice:matrix.org",
            "content": {"msgtype": "m.text", "body": "!play https://youtu.be/test"},
            "origin_server_ts": 12345,
            "event_id": "$megolm_001",
        })
        bot.client.decrypt_event = MagicMock(return_value=decrypted_msg)

        # Trigger room key arrival
        key_event = MagicMock(spec=RoomKeyEvent)
        await bot.on_room_key(key_event)

        # Event should now be processed and removed from pending buffer
        self.assertNotIn("$megolm_001", bot._pending_megolm_events)
        bot.on_message.assert_awaited_once_with(room, decrypted_msg)


if __name__ == "__main__":
    unittest.main()
