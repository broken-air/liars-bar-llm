import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/game-engine.js';
import { buildDecisionPrompt, parseDecision } from '../src/llm-decision.js';
import { LLM_SEATS, PERSONAS } from '../src/llm-config.js';

const players = ['a', 'b'].map((id) => ({ id, name: id.toUpperCase() }));

function game() {
  const engine = new GameEngine(players, { random: () => 0 });
  engine.start();
  return engine;
}

test('parseDecision 提取 behavior 台词,缺省为空串', () => {
  const play = parseDecision('{"action":"play","indices":[0,1],"behavior":"（敲了敲桌面）看好了"}', 5, true);
  assert.deepEqual(play, { action: 'play', indices: [0, 1], behavior: '（敲了敲桌面）看好了' });
  const challenge = parseDecision('{"action":"challenge","behavior":"就这？"}', 5, true);
  assert.deepEqual(challenge, { action: 'challenge', behavior: '就这？' });
  assert.equal(parseDecision('{"action":"play","indices":[2]}', 5, true).behavior, '');
  assert.equal(parseDecision('{"action":"play","indices":[0],"behavior":42}', 5, true).behavior, '');
});

test('behavior 会被裁剪到 60 字以内并去掉首尾空白', () => {
  const decision = parseDecision(`{"action":"challenge","behavior":"  ${'啊'.repeat(80)}  "}`, 5, true);
  assert.equal(decision.behavior.length, 60);
  assert.equal(decision.behavior.startsWith(' '), false);
  assert.equal(decision.behavior.endsWith(' '), false);
});

test('buildDecisionPrompt 注入人设与本轮发言', () => {
  const engine = game();
  const persona = { label: '老千·小飞', prompt: '台词要有江湖气' };
  const talk = [{ name: 'B', text: '（冷笑）就这？' }];
  const { system, user } = buildDecisionPrompt(engine, 'a', talk, persona);
  assert.match(system, /台词要有江湖气/);
  assert.match(system, /behavior/);
  assert.match(user, /本轮发言/);
  assert.match(user, /（冷笑）就这？/);
});

test('没有人设与发言时 prompt 保持可用', () => {
  const engine = game();
  const { system, user } = buildDecisionPrompt(engine, 'a', [], null);
  assert.doesNotMatch(system, /人设：/);
  assert.match(user, /还没有人开口/);
});

test('LLM_SEATS 的 persona 都能在 PERSONAS 里找到且字段齐全', () => {
  LLM_SEATS.forEach((seat) => {
    assert.ok(PERSONAS[seat.persona], `缺少人设:${seat.persona}`);
    assert.ok(PERSONAS[seat.persona].label);
    assert.ok(PERSONAS[seat.persona].prompt.length > 20);
  });
});
