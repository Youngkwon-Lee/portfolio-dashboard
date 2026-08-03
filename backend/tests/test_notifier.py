import os
import unittest
from unittest.mock import AsyncMock, patch

import notifier


class NotifierTests(unittest.IsolatedAsyncioTestCase):
    async def test_discord_webhook_is_opt_in_and_truncates_payload(self) -> None:
        with patch.dict(os.environ, {"DISCORD_WEBHOOK_URL": "https://discord.invalid/webhook/test"}, clear=True), \
             patch.object(notifier.httpx, "AsyncClient") as client_factory:
            client = client_factory.return_value.__aenter__.return_value
            client.post = AsyncMock(return_value=type("Response", (), {"status_code": 204})())

            delivered = await notifier.send("<b>paper</b> &amp; " + "x" * 2100)

        self.assertTrue(delivered)
        client.post.assert_awaited_once()
        payload = client.post.await_args.kwargs["json"]
        self.assertEqual(len(payload["content"]), 2000)
        self.assertTrue(payload["content"].startswith("paper & "))
        self.assertNotIn("<b>", payload["content"])

    async def test_notification_without_runtime_credentials_does_not_call_network(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch.object(notifier.httpx, "AsyncClient") as client_factory:
            delivered = await notifier.send("paper event")

        self.assertFalse(delivered)
        client_factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
