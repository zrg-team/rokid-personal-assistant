/**
 * Gmail. Read the inbox by voice, and — new — send.
 *
 * The send path is why `owner_bindings` and the gate matter: `GMAIL_SEND_EMAIL`
 * was declared in the registry but wired to nothing, so "Kavi gmail send…" fell
 * through to a search. Here it is a real, `outbound`-risk tool; the connections
 * function's gate stages it rather than firing it.
 */

import type { Adapter, Planned } from './types.ts';
import { ackCard, type Card, listCard } from './shape.ts';

const FETCH = 'GMAIL_FETCH_EMAILS';
const SEND = 'GMAIL_SEND_EMAIL';

export const gmail: Adapter = {
  slug: 'gmail',
  name: 'Gmail',
  aliases: ['gmail', 'mail', 'email', 'hop thu'], // 'thu' alone removed — folds onto 'thứ' (Monday)
  summary: 'Read and search your inbox, and send by voice',
  category: 'Communication',
  icon: '✉️',
  tools: [
    {
      name: FETCH,
      risk: 'read',
      label: 'Fetch emails',
      fields: [
        { key: 'query', label: 'Gmail search', type: 'text', default: 'newer_than:2d' },
        { key: 'max_results', label: 'How many at most', type: 'number', default: 4 },
      ],
    },
    // SEND declares no fields on purpose: it is `outbound`, and an outbound tool
    // is excluded from the console's action catalog entirely. A one-word
    // shortcut must never be able to send on the wearer's behalf.
    { name: SEND, risk: 'outbound' },
  ],

  plan(action: string): Planned | null {
    const a = String(action || '').trim();

    // "send …", "reply …", "email Tracy …" → the outbound path. Recipient and
    // body resolution happen in the gate (server-side, exact-or-ask); here we
    // only classify the verb. A bare send with no parseable target is still
    // outbound — the gate turns it into a "who?" rather than a wrong send.
    if (/^(send|reply|email|write|tell)\b/i.test(a)) {
      return { tool: SEND, args: { _raw: a }, risk: 'outbound' };
    }

    // Everything else is a read. The spoken phrase becomes a Gmail search query;
    // a bare "Kavi gmail" shows the last two days.
    return { tool: FETCH, args: { query: a || 'newer_than:2d', max_results: 4 }, risk: 'read' };
  },

  project(tool: string, data: unknown): Card {
    if (tool === SEND) return ackCard('Sent', 'Sent.');
    return listCard(
      data,
      'email',
      ['subject', 'snippet', 'title', 'text'],
      ['sender', 'from', 'fromName', 'from_email', 'date'],
    );
  },
};
