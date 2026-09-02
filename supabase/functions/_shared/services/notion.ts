/**
 * Notion — search the wearer's pages, and capture a thought into one.
 *
 * The glasses case is narrow on purpose. Reading a Notion page on a 480x352
 * single-green HUD is not a thing anyone wants; *finding* one, and *adding a
 * line to* one, are. So this exposes a search and an append, and nothing else.
 *
 * Capture needs a page to capture INTO, and no utterance can name a Notion
 * block id — so it is a binding, chosen once in the console. Search needs no
 * binding at all, which is why it stays useful before setup is finished.
 *
 * Tool slugs and argument names verified against Composio's Notion toolkit.
 */

import type { Adapter, Planned } from './types.ts';
import { ackCard, type Card, listCard } from './shape.ts';

const SEARCH = 'NOTION_SEARCH_NOTION_PAGE';
const APPEND = 'NOTION_APPEND_TEXT_BLOCKS';
const FETCH_PAGES = 'NOTION_FETCH_DATA';

export const notion: Adapter = {
  slug: 'notion',
  name: 'Notion',
  aliases: ['notion', 'notes', 'note book', 'ghi chu'],
  summary: 'Find a page, or capture a line into your inbox page',
  category: 'Productivity',
  icon: '📓',

  tools: [
    {
      name: SEARCH,
      risk: 'read',
      label: 'Search my pages',
      fields: [
        { key: 'query', label: 'Search for', type: 'text' },
        {
          key: 'filter_value',
          label: 'Look in',
          type: 'choice',
          default: 'page',
          choices: [
            { value: 'page', label: 'Pages' },
            { value: 'database', label: 'Databases' },
          ],
        },
        { key: 'page_size', label: 'How many at most', type: 'number', default: 5 },
      ],
    },
    {
      name: APPEND,
      // `self` and not `outbound`: it writes to the wearer's own workspace and
      // sends nothing to anyone, so it runs without the confirm gate. See the
      // Risk notes in types.ts.
      risk: 'self',
      label: 'Capture a line',
      fields: [
        { key: 'content', label: 'What to capture', type: 'text', required: true },
      ],
    },
  ],

  bindings: [
    // Composio's search returns pages the integration can see; the console
    // renders them as the picker for where a capture lands.
    { key: 'page', label: 'Capture into', listTool: FETCH_PAGES },
  ],

  plan(action: string, bindings: Record<string, string>): Planned | null {
    const a = String(action || '').trim();
    const page = bindings.page || '';

    if (/^(note|capture|jot|write down|add|remember)\b/i.test(a)) {
      if (!page) return { tool: APPEND, args: {}, risk: 'self', missingBinding: 'page' };
      const text = a.replace(/^(note|capture|jot|write down|add|remember)\s+/i, '').trim();
      return {
        tool: APPEND,
        args: {
          block_id: page,
          children: [{ content: text || a }],
        },
        risk: 'self',
      };
    }

    // A bare "Kavi notion" is a search with no query, which Notion answers with
    // the most recently touched pages — a reasonable "what was I working on".
    return {
      tool: SEARCH,
      args: { query: a, filter_value: 'page', page_size: 5 },
      risk: 'read',
    };
  },

  project(tool: string, data: unknown): Card {
    if (tool === APPEND) return ackCard('Captured', 'Captured it.');
    return listCard(data, 'page', ['title', 'name', 'plain_text'], ['last_edited_time', 'url']);
  },
};
