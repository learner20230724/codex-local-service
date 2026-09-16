import test from 'node:test';
import assert from 'node:assert/strict';
import { chatRequestToOptions, responsesRequestToOptions } from '../adapter/openai-to-codex.js';

test('request-specific reasoning effort survives Chat and Responses adaptation', () => {
  assert.equal(chatRequestToOptions({model:'gpt-6-astra',messages:[{role:'user',content:'Hello'}],reasoning_effort:'high'}).options.reasoningEffort,'high');
  assert.equal(responsesRequestToOptions({model:'gpt-6-astra',input:'Hello',reasoning:{effort:'xhigh'}}).options.reasoningEffort,'xhigh');
});
test('clients that omit reasoning effort keep the existing service default', () => {
  assert.equal(chatRequestToOptions({messages:[{role:'user',content:'Hello'}]}).options.reasoningEffort,undefined);
  assert.equal(responsesRequestToOptions({input:'Hello'}).options.reasoningEffort,undefined);
});
