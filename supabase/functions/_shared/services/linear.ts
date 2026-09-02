/**
 * Linear — what is assigned to the wearer, and filing something new.
 *
 * "Kavi linear" answering "you have four issues, the top one is X" is the kind
 * of thing a HUD is actually good for: a glance, not a workspace.
 *
 * Creating an issue needs a team id, which no utterance can supply, so the team
 * is a binding chosen once in the console from `LINEAR_LIST_LINEAR_TEAMS`.
 * Listing does not need one — `LINEAR_LIST_LINEAR_ISSUES` scopes to the caller
 * on its own — so reads work before setup is finished, and only the write is
 * gated behind it.
 *
 * Tool slugs and argument names verified against Composio's Linear toolkit.
 */

import type { Adapter, Planned } from './types.ts';
import { ackCard, type Card, listCard } from './shape.ts';

const LIST = 'LINEAR_LIST_LINEAR_ISSUES';
const CREATE = 'LINEAR_CREATE_LINEAR_ISSUE';
const SEARCH = 'LINEAR_SEARCH_ISSUES';
const LIST_TEAMS = 'LINEAR_LIST_LINEAR_TEAMS';

export const linear: Adapter = {
  slug: 'linear',
  name: 'Linear',
  aliases: ['linear', 'issues', 'tickets'],
  summary: 'See what is assigned to you, and file a new issue',
  category: 'Engineering',
  icon: '📐',

  tools: [
    {
      name: LIST,
      risk: 'read',
      label: 'List issues',
      fields: [
        { key: 'first', label: 'How many at most', type: 'number', default: 5 },
      ],
    },
    {
      name: SEARCH,
      risk: 'read',
      label: 'Search issues',
      fields: [
        { key: 'query', label: 'Search for', type: 'text', required: true },
      ],
    },
    {
      name: CREATE,
      risk: 'self',
      label: 'File an issue',
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'description', label: 'Description', type: 'text' },
      ],
    },
  ],

  bindings: [
    { key: 'team', label: 'Which team', listTool: LIST_TEAMS },
  ],

  plan(action: string, bindings: Record<string, string>): Planned | null {
    const a = String(action || '').trim();
    const team = bindings.team || '';

    if (/^(file|create|new|open|add|raise)\b/i.test(a)) {
      if (!team) return { tool: CREATE, args: {}, risk: 'self', missingBinding: 'team' };
      const title = a.replace(/^(file|create|new|open|add|raise)\s+/i, '').trim();
      return { tool: CREATE, args: { team_id: team, title: title || a }, risk: 'self' };
    }

    // A spoken phrase is a search; a bare "Kavi linear" is "what is on me".
    if (a) return { tool: SEARCH, args: { query: a }, risk: 'read' };
    return { tool: LIST, args: { first: 5 }, risk: 'read' };
  },

  project(tool: string, data: unknown): Card {
    if (tool === CREATE) return ackCard('Issue filed', 'Filed it.');
    return listCard(data, 'issue', ['title', 'name', 'identifier'], ['state', 'status', 'priority', 'assignee']);
  },
};
