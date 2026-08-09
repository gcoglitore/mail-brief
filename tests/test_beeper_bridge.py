import unittest
from unittest import mock

from pipeline import beeper_bridge as bridge


class BeeperReplyMetadata(unittest.TestCase):
    def test_linkedin_conversations_are_preserved_and_marked_sendable(self):
        def fake_get(path, _token):
            if path.startswith("/v1/chats?"):
                return [{
                    "id": "linkedin-chat-1",
                    "network": "linkedin",
                    "title": "Morgan Lee",
                    "type": "single",
                    "unreadCount": 1,
                    "lastActivity": "2026-07-31T20:00:00Z",
                }]
            return [{
                "id": "message-1",
                "text": "Are we still on?",
                "timestamp": "2026-07-31T20:00:00Z",
                "senderName": "Sam",
                "isSender": False,
                "type": "TEXT",
            }]

        with mock.patch.object(bridge, "beeper_get", side_effect=fake_get):
            chats = bridge.build_beeper_chats("token")

        self.assertEqual(len(chats), 1)
        self.assertTrue(chats[0]["sendable"])
        self.assertEqual(chats[0]["id"], "linkedin-chat-1")
        self.assertEqual(chats[0]["network"], "linkedin")

    def test_linkedin_is_monitored_by_default(self):
        self.assertIn("linkedin", bridge.EXPECTED_NETWORKS)


if __name__ == "__main__":
    unittest.main()
