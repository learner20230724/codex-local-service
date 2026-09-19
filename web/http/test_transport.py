# SPDX-License-Identifier: AGPL-3.0-only
import base64
import json
import tempfile
import time
import unittest
from pathlib import Path
from transport import Answer, MODEL, PUBLIC_MODEL, WebError, load_session, payload_for, sse_data, websocket_events


def message(text, model=MODEL, effort="min", status="in_progress", channel="final"):
    return {"message": {"id": "test-message", "author": {"role": "assistant"}, "recipient": "all", "channel": channel,
                        "status": status, "content": {"content_type": "text", "parts": [text]},
                        "metadata": {"model_slug": model, "resolved_model_slug": model, "thinking_effort": effort}}}


class TransportTests(unittest.TestCase):
    def test_temporary_unpersonalized_and_independent_history(self):
        body = {"model": PUBLIC_MODEL, "input": [{"role": "user", "content": "remember AZURE"},
                  {"role": "assistant", "content": "Understood"}, {"role": "user", "content": "repeat it"}],
                "conversation_id": "must-not-reuse", "history_and_training_disabled": False,
                "temporary_chat_requests_personalization": True}
        first, second = payload_for(body), payload_for(body)
        self.assertTrue(first["history_and_training_disabled"])
        self.assertFalse(first["temporary_chat_requests_personalization"])
        self.assertEqual(first["conversation_origin"], "tpp")
        self.assertEqual(first["thinking_effort"], "min")
        self.assertNotIn("conversation_id", first)
        self.assertNotEqual(first["parent_message_id"], second["parent_message_id"])
        self.assertEqual([m["author"]["role"] for m in first["messages"]], ["user", "assistant", "user"])
        self.assertEqual(first["messages"][0]["content"]["parts"], ["remember AZURE"])

    def test_model_and_effort_are_independent(self):
        for effort, expected in [("low", "min"), ("medium", "standard"), ("high", "extended")]:
            result = payload_for({"model": PUBLIC_MODEL, "input": "hello", "reasoning": {"effort": effort}})
            self.assertEqual(result["model"], MODEL)
            self.assertEqual(result["thinking_effort"], expected)
        with self.assertRaises(WebError):
            payload_for({"model": PUBLIC_MODEL, "input": "hello", "reasoning": {"effort": "none"}})

    def test_rejects_tool_and_image_input(self):
        for extra in [{"tools": [{"type": "function"}]}, {"previous_response_id": "old"},
                      {"input": [{"role": "user", "content": [{"type": "input_image", "image_url": "x"}]}]}]:
            with self.assertRaises(WebError):
                payload_for({"model": PUBLIC_MODEL, "input": "hello", **extra})

    def test_model_downgrade_or_wrong_effort_never_emits_text(self):
        for event in [message("must not escape", model="gpt-5-6"), message("must not escape", effort="extended")]:
            answer = Answer("min")
            with self.assertRaises(WebError): answer.accept(event)
            self.assertEqual(answer.text, "")

    def test_only_final_text_and_terminal_success_count(self):
        answer = Answer("min")
        self.assertEqual(answer.accept(message("hidden reasoning", channel="analysis")), "")
        self.assertEqual(answer.accept(message("你")), "你")
        with self.assertRaises(WebError): answer.complete()
        self.assertEqual(answer.accept(message("你好", status="finished_successfully")), "好")
        self.assertEqual(answer.accept(message("你好", status="finished_successfully")), "")
        answer.complete()
        with self.assertRaises(WebError): answer.accept(message("rewritten"))

    def test_echoed_assistant_history_is_not_current_output(self):
        answer = Answer("min", ["test-message"])
        self.assertEqual(answer.accept(message("previous answer", model="gpt-5-6", status="finished_successfully")), "")
        self.assertFalse(answer.verified)
        self.assertFalse(answer.finished)

    def test_sse_and_websocket_catchup_filter_other_topics(self):
        encoded = 'data: {"message":{"value":"你好"}}\n\ndata: [DONE]\n\n'
        expected = [{"message": {"value": "你好"}}, {"type": "done"}]
        self.assertEqual(list(sse_data(encoded.splitlines())), expected)
        event = {"type": "message", "topic_id": "ours", "payload": {
            "type": "conversation-turn-stream", "payload": {"encoded_item": encoded}}}
        self.assertEqual(list(websocket_events({"reply": {"catchups": [event]}}, "ours")), expected)
        self.assertEqual(list(websocket_events(event, "unrelated")), [])

    def test_credentials_require_private_permissions_and_live_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.json"
            def write(exp):
                part = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
                path.write_text(json.dumps({"headers": {"authorization": "Bearer fake." + part + ".signature"},
                                            "temporary_chat": True, "personalization": False}))
                path.chmod(0o600)
            write(time.time() + 3600)
            self.assertTrue(load_session(path)["temporary_chat"])
            path.chmod(0o644)
            with self.assertRaises(WebError): load_session(path)
            write(time.time() - 1)
            with self.assertRaises(WebError): load_session(path)


if __name__ == "__main__":
    unittest.main()
