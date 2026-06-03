import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isAuthorizedRequest, serializeStreamChatParams } from '../worker-protocol.js';

describe('worker protocol', () => {
  it('requires a matching bearer token', () => {
    assert.equal(isAuthorizedRequest('Bearer abc', 'abc'), true);
    assert.equal(isAuthorizedRequest('Bearer wrong', 'abc'), false);
    assert.equal(isAuthorizedRequest(undefined, 'abc'), false);
  });

  it('does not serialize process-local callbacks', () => {
    const params = serializeStreamChatParams({
      prompt: 'hello',
      sessionId: 's1',
      abortController: new AbortController(),
      onRuntimeStatusChange: () => {},
    });

    assert.equal(params.prompt, 'hello');
    assert.equal(params.sessionId, 's1');
    assert.equal('abortController' in params, false);
    assert.equal('onRuntimeStatusChange' in params, false);
  });
});
