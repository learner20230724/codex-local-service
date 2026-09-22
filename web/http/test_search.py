# SPDX-License-Identifier: AGPL-3.0-only
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
from search import Search
from transport import Answer
from test_transport import message

MARKER = 'citeturn123search0turn123search1'
REFERENCES = [{'type': 'grouped_webpages', 'matched_text': MARKER, 'items': [
    {'title': 'Python', 'url': 'https://www.python.org/', 'snippet': 'do not forward',
     'supporting_websites': [{'title': 'Downloads', 'url': 'https://www.python.org/downloads/'}]}]}]

class SearchTests(unittest.TestCase):
    def test_grouped_citations_and_results_preserve_all_original_links(self):
        search = Search()
        search.observe({'id': 'call', 'author': {'role': 'assistant'}, 'recipient': 'web.run',
                        'content': {'parts': [json.dumps({'search_query': [{'q': 'Python download'}]})]}})
        search.observe({'author': {'role': 'tool', 'name': 'web.run'}, 'metadata': {'search_result_groups': [
            {'entries': [{'url': 'https://www.python.org/', 'title': 'Python', 'ref_id': {'turn_index': 123, 'ref_type': 'search', 'ref_index': 0}},
                         {'url': 'https://www.python.org/doc/', 'title': 'Documentation', 'snippet': 'do not forward'}]}]}})
        search.observe({'author': {'role': 'assistant'}, 'metadata': {'content_references': REFERENCES}})
        text, annotations = search.render('😀 资料 ' + MARKER + '。')
        self.assertNotIn('', text)
        self.assertEqual(len(annotations), 2)
        self.assertEqual(annotations[0]['start_index'], 5)
        for row in annotations:
            self.assertTrue(text[row['start_index']:row['end_index']].startswith('['))
        info, calls = search.result()
        self.assertTrue(info['performed'])
        self.assertEqual(info['queries'], ['Python download'])
        self.assertEqual(len(info['sources']), 3)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0]['action']['sources']), 2)
        self.assertNotIn('do not forward', json.dumps([info, calls, annotations]))

    def test_search_result_ref_fallback_and_unsafe_links(self):
        s = Search()
        s.observe({'author': {'role': 'tool'}, 'metadata': {'search_result_groups': [{'entries': [
            {'url': 'https://example.com', 'title': 'Example', 'ref_id': {'turn_index': 123, 'ref_type': 'search', 'ref_index': 0}},
            {'url': 'javascript:alert(1)'}, {'url': 'https://secret:secret@example.com'}]}]}})
        text, annotations = s.render(MARKER)
        self.assertEqual(text, '[Example](https://example.com)')
        self.assertEqual(len(annotations), 1)
        self.assertEqual(len(s.result()[0]['sources']), 1)

    def test_plain_links_and_input_history_are_not_search_evidence(self):
        answer = Answer('min', ['test-message'])
        event = message('old response')
        event['message']['metadata']['content_references'] = REFERENCES
        answer.accept(event)
        self.assertEqual(answer.search.result()[0]['sources'], [])
        s = Search(); text = '[Python](https://www.python.org/)'
        self.assertEqual(s.render(text), (text, []))
        self.assertFalse(s.result()[0]['performed'])

    def test_worker_buffers_split_markers_until_late_metadata_and_stream_matches_final(self):
        import worker
        class FakeTransport:
            def __init__(self, *args): pass
            def close(self): pass
            def events(self, payload):
                yield {'message': {'id': 'call', 'author': {'role': 'assistant'}, 'recipient': 'web.run', 'content': {'parts': ['{}']}}}
                final = '😀 中文 ' + MARKER + ' end'
                for i in range(1, len(final) + 1): yield message(final[:i])
                e = message(final, status='finished_successfully')
                e['message']['metadata']['content_references'] = REFERENCES
                yield e
        output = io.StringIO()
        with patch.object(worker, 'Transport', FakeTransport), patch.object(worker, 'load_session', return_value={}), patch.object(worker.signal, 'signal'), patch.object(worker.sys, 'stdin', io.StringIO(json.dumps({'model': 'chatgpt-web/gpt-6-astra', 'input': 'search'}))), redirect_stdout(output):
            worker.main()
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[-1]['type'], 'done')
        rendered = ''.join(e['text'] for e in events if e['type'] == 'delta')
        self.assertNotIn('', rendered)
        self.assertTrue(rendered.endswith(' end'))
        for row in events[-1]['annotations']:
            self.assertEqual(rendered[row['start_index']:row['end_index']], f"[{row['title']}]({row['url']})")
        self.assertTrue(events[-1]['search']['performed'])

if __name__ == '__main__': unittest.main()
