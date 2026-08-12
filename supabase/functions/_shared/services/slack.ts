/**
 * Slack. Catch up on a channel, and post to it.
 *
 * Slack is the reason `owner_bindings` exists. Both its tools take a `channel`
 * id that is NOT derivable from an utterance — a per-owner fact chosen once. The
 * old code shipped `SLACK_FETCH_CONVERSATION_HISTORY` with no channel and so
 * never worked; `SLACK_SEND_MESSAGE` was wired to nothing at all. Here, a missing
 * channel binding produces a `needs-setup` card (the console has a picker),
 * never a broken call.
 */

import type { Adapter, Planned } from './types.ts';
import { ackCard, type Card, listCard } from './shape.ts';

const HISTORY = 'SLACK_FETCH_CONVERSATION_HISTORY';
const SEND = 'SLACK_SEND_MESSAGE';

export const slack: Adapter = {
  slug: 'slack',
  name: 'Slack',
  aliases: ['slack', 'tin nhan'],
  summary: 'Catch up on a channel and post to it',
  category: 'Communication',
  icon: '💬',
  tools: [
    { name: HISTORY, risk: 'read' },
    { name: SEND, risk: 'outbound' },
  ],
  bindings: [
    { key: 'channel', label: 'Default channel', listTool: 'SLACK_LIST_ALL_CHANNELS' },
  ],

  plan(action: string, bindings: Record<string, string>): Planned | null {
    const a = String(action || '').trim();
    const channel = bindings.channel || '';

    if (/^(send|post|reply|tell|message)\b/i.test(a)) {
      if (!channel) return { tool: SEND, args: {}, risk: 'outbound', missingBinding: 'channel' };
      return { tool: SEND, args: { channel, _raw: a }, risk: 'outbound' };
    }

    if (!channel) return { tool: HISTORY, args: {}, risk: 'read', missingBinding: 'channel' };
    return { tool: HISTORY, args: { channel, limit: 4 }, risk: 'read' };
  },

  project(tool: string, data: unknown): Card {
    if (tool === SEND) return ackCard('Posted', 'Posted to Slack.');
    return listCard(
      data,
      'message',
      ['text', 'message', 'title'],
      ['user', 'username', 'user_name', 'ts', 'timestamp'],
    );
  },
};
