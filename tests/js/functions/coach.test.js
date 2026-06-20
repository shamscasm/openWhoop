// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { onRequestPost } from '../../../functions/api/coach.js';

function jsonReq(body) {
  return new Request('https://getwhoof.pages.dev/api/coach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('coach onRequestPost', () => {
  it('503 when the AI binding is missing', async () => {
    const res = await onRequestPost({ request: jsonReq({ message: 'hi' }), env: {} });
    expect(res.status).toBe(503);
  });

  it('400 on an empty message', async () => {
    const env = { AI: { run: async () => ({ response: 'x' }) } };
    const res = await onRequestPost({ request: jsonReq({ message: '   ' }), env });
    expect(res.status).toBe(400);
  });

  it('400 on a non-JSON body', async () => {
    const env = { AI: { run: async () => ({ response: 'x' }) } };
    const bad = new Request('https://x/api/coach', { method: 'POST', body: 'not json' });
    const res = await onRequestPost({ request: bad, env });
    expect(res.status).toBe(400);
  });

  it('returns the reply and forwards only whitelisted metrics into the system prompt', async () => {
    let seen;
    const env = { AI: { run: async (_model, opts) => { seen = opts; return { response: 'Recovery is solid.' }; } } };
    const res = await onRequestPost({
      request: jsonReq({ message: 'how am I?', metrics: { recovery_score: 72, secret_field: 'leak' } }),
      env,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reply).toBe('Recovery is solid.');
    const sys = seen.messages[0].content;
    expect(sys).toContain('recovery_score=72');
    expect(sys).not.toContain('secret_field');   // unknown fields are dropped
  });

  it('clamps history to the last 8 turns and appends the user message last', async () => {
    let seen;
    const env = { AI: { run: async (_m, o) => { seen = o; return { response: 'ok' }; } } };
    const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    await onRequestPost({ request: jsonReq({ message: 'q', history }), env });
    expect(seen.messages.length).toBeLessThanOrEqual(1 + 8 + 1); // system + history + user
    expect(seen.messages[seen.messages.length - 1]).toEqual({ role: 'user', content: 'q' });
    expect(seen.messages[0].role).toBe('system');
  });

  it('502 when the model returns nothing', async () => {
    const env = { AI: { run: async () => ({ response: '' }) } };
    const res = await onRequestPost({ request: jsonReq({ message: 'hi' }), env });
    expect(res.status).toBe(502);
  });
});
