import { CARD_NAMES } from './game-engine.js';
import { PERSONAS } from './llm-config.js';

const DECISION_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;
const MAX_BEHAVIOR_LENGTH = 60;

export function buildDecisionPrompt(engine, id, talk = [], persona = null) {
  const me = engine.player(id);
  const canChallenge = Boolean(engine.lastPlay);
  const state = {
    目标牌: `${engine.target}(${CARD_NAMES[engine.target]})`,
    你的手牌: me.hand.map((card, index) => ({
      下标: index,
      牌: card === 'JOKER' ? 'JOKER(万能牌)' : `${card}(${CARD_NAMES[card]})`,
    })),
    你已扣扳机次数: me.shots,
    桌面牌堆总数: engine.pile.length,
    上一手宣称: engine.lastPlay
      ? { 玩家: engine.player(engine.lastPlay.player).name, 宣称张数: engine.lastPlay.count }
      : null,
    各家态势: engine.players.map((player) => ({
      名字: player.name,
      存活: player.alive,
      剩余手牌: player.hand.length,
      已扣扳机: player.shots,
    })),
    本轮发言: talk.length ? talk.map((entry) => `${entry.name}：${entry.text}`) : '（还没有人开口）',
    最近事件: engine.history.slice(-10),
  };
  const system = [
    `你是“骗子酒馆”牌桌上的 AI 玩家，你的名字是「${me.name}」。`,
    ...(persona ? [`人设：${persona.prompt}`] : []),
    '',
    '规则:',
    '- 牌堆共 20 张:A/K/Q 各 6 张 + 2 张 JOKER(万能牌,可充当任意目标牌)。',
    '- 每局随机指定一张目标牌,每人发 5 张手牌。',
    '- 轮到你时二选一:',
    '  1) 出牌:暗扣打出 1–3 张手牌,统一宣称是目标牌(允许掺假牌撒谎);',
    '  2) 质疑上一手:翻开上一手的牌,若其中掺了非目标牌,上一手玩家扣扳机;若全是目标牌或万能牌,你扣扳机。',
    '- 左轮 6 个弹巢随机 1 发子弹,每扣一次推进一格,中弹即淘汰;手牌全部出完即安全,活到最后获胜。',
    '',
    '策略提示:记牌(A/K/Q 各 6 张、JOKER 共 2 张),结合桌面牌堆估算上一手宣称的真实性;手牌将尽的人急于清牌,更可能撒谎。',
    '',
    '台词(behavior 字段,可选):决策时可附一句面向牌桌的台词,纯文字、不超过 30 字;动作写在中文圆括号（）里,与台词连成一句,例如:"（转着酒杯，眯起眼）这把稳了，信我。"台词要有表演感,不要复述"打出几张牌"这类人人可见的公开信息。不想说话就省略该字段。',
    '',
    canChallenge
      ? '现在桌上已有上一手宣称,你可以质疑,也可以继续出牌。'
      : '本局刚开局,没有可质疑的对象,你只能出牌。',
    '只输出一个 JSON 对象,禁止任何多余文字:',
    '- 出牌:{"action":"play","indices":[下标,…],"behavior":"台词,可省略"}(1–3 个不重复的手牌下标)',
    '- 质疑:{"action":"challenge","behavior":"台词,可省略"}',
  ].join('\n');
  const user = `${JSON.stringify(state, null, 2)}\n\n请给出你的决策(只输出 JSON)。`;
  return { system, user, canChallenge };
}

export function parseDecision(content, handLength, canChallenge) {
  if (typeof content !== 'string' || !content.includes('{')) return null;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const behavior = typeof parsed?.behavior === 'string' ? parsed.behavior.trim().slice(0, MAX_BEHAVIOR_LENGTH) : '';
  if (parsed?.action === 'challenge') return canChallenge ? { action: 'challenge', behavior } : null;
  if (parsed?.action !== 'play' || !Array.isArray(parsed.indices)) return null;
  const indices = [...new Set(parsed.indices)].filter(
    (index) => Number.isInteger(index) && index >= 0 && index < handLength,
  );
  if (!indices.length || indices.length > 3) return null;
  return { action: 'play', indices, behavior };
}

export async function decideAI(seat, engine, id, talk = [], fetchImpl = fetch) {
  const { system, user, canChallenge } = buildDecisionPrompt(engine, id, talk, seat.persona || null);
  const handLength = engine.player(id).hand.length;
  const messages = [{ role: 'user', content: user }];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchImpl('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: seat.provider,
        model: seat.model,
        system,
        messages,
        max_tokens: 8192,
      }),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
    const data = await response.json();
    const decision = parseDecision(data.content, handLength, canChallenge)
      ?? parseDecision(data.reasoning, handLength, canChallenge);
    if (decision) return decision;
    messages.push(
      { role: 'assistant', content: String(data.content ?? data.reasoning ?? '').slice(0, 500) },
      {
        role: 'user',
        content: canChallenge
          ? '上面的输出无法解析。只输出 {"action":"play","indices":[…],"behavior":"…"} 或 {"action":"challenge","behavior":"…"}。'
          : '上面的输出无法解析。只能出牌:{"action":"play","indices":[…],"behavior":"…"}(1–3 个不重复下标)。',
      },
    );
  }
  return null;
}
