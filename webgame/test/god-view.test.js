import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/game-engine.js';

const players = ['a', 'b'].map((id) => ({ id, name: id.toUpperCase() }));

function game() {
  const engine = new GameEngine(players, { random: () => 0 });
  engine.start();
  return engine;
}

test('上帝视角公开所有手牌、上一手实际牌面与牌堆构成', () => {
  const engine = game();
  const dealtHands = engine.players.map((player) => [...player.hand]);
  const view = engine.viewFor('spectator', { god: true });
  assert.deepEqual(view.players.map((player) => player.hand), dealtHands);

  engine.play('a', [0, 1]);
  const after = engine.viewFor('spectator', { god: true });
  assert.equal(after.lastPlay.count, 2);
  assert.deepEqual(after.lastPlay.cards, dealtHands[0].slice(0, 2));
  assert.deepEqual(after.pileCards, dealtHands[0].slice(0, 2));
});

test('非 god 视图保持原样:别人手牌不可见,lastPlay 只有张数', () => {
  const engine = game();
  engine.play('a', [0]);
  const plain = engine.viewFor('b');
  assert.equal('hand' in plain.players.find((player) => player.id === 'a'), false);
  assert.equal(Array.isArray(plain.players.find((player) => player.id === 'b').hand), true);
  assert.deepEqual(plain.lastPlay, { player: 'a', count: 1 });
  assert.equal('pileCards' in plain, false);
  assert.equal('cards' in plain.lastPlay, false);
});
