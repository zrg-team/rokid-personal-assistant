/**
 * Google Calendar.
 *
 * Calendar reads have a richer on-device path (the rule planner in
 * utils/planner.js resolves agendas, attendees, free slots, named-person
 * questions), so they do not come through `connections.execute`. This adapter
 * exists so the registry is complete — aliases and connection status work — and
 * so the one write, quick-add, has a home with the right risk class.
 *
 * Quick-add is `self` risk: it writes the wearer's OWN calendar, so it executes
 * without the outbound confirm gate. (A reminder/event the wearer just dictated
 * should not need a second press.)
 */

import type { Adapter, Planned } from './types.ts';
import { ackCard, type Card, listCard } from './shape.ts';

const LIST = 'GOOGLECALENDAR_EVENTS_LIST';
const QUICK_ADD = 'GOOGLECALENDAR_QUICK_ADD';

export const googlecalendar: Adapter = {
  slug: 'googlecalendar',
  name: 'Google Calendar',
  aliases: ['google calendar', 'gcal', 'calendar', 'lich', 'agenda'],
  summary: 'Read your day, answer calendar questions, and add events',
  category: 'Productivity',
  icon: '📅',
  tools: [
    {
      name: LIST,
      risk: 'read',
      label: 'List events for a day',
      // The argument names are camelCase here and snake_case on QUICK_ADD
      // because that is what Composio's schema says for each — its own docs are
      // inconsistent between the two tools. Declared once, here.
      fields: [
        { key: 'calendarId', label: 'Calendar', type: 'text', default: 'primary' },
        {
          // `_` prefix: a control, not an argument. It writes the two below.
          key: '_day',
          label: 'Which day',
          type: 'day',
          default: 'today',
          expands: { timeMin: 'start', timeMax: 'end' },
          choices: [
      { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
          { value: 'yesterday', label: 'Yesterday' },
          { value: '+2', label: 'In 2 days' },
          { value: '+7', label: 'In a week' },
          { value: 'monday', label: 'Monday' },
          { value: 'tuesday', label: 'Tuesday' },
          { value: 'wednesday', label: 'Wednesday' },
          { value: 'thursday', label: 'Thursday' },
          { value: 'friday', label: 'Friday' },
          { value: 'saturday', label: 'Saturday' },
          { value: 'sunday', label: 'Sunday' },
          ],
        },
        { key: 'maxResults', label: 'How many at most', type: 'number', default: 25 },
      ],
    },
    {
      name: QUICK_ADD,
      risk: 'self',
      label: 'Add an event',
      fields: [
        { key: 'calendar_id', label: 'Calendar', type: 'text', default: 'primary' },
        { key: 'text', label: 'What to add', type: 'text', required: true },
      ],
    },
  ],

  plan(action: string): Planned | null {
    const a = String(action || '').trim();
    if (/^(add|create|book|schedule|set up|put|remind)\b/i.test(a)) {
      return { tool: QUICK_ADD, args: { calendar_id: 'primary', text: a }, risk: 'self' };
    }
    return { tool: LIST, args: { calendarId: 'primary', singleEvents: true, orderBy: 'startTime' }, risk: 'read' };
  },

  project(tool: string, data: unknown): Card {
    if (tool === QUICK_ADD) return ackCard('Added to your calendar', 'Added it.');
    return listCard(
      data,
      'event',
      ['summary', 'title', 'text'],
      ['start', 'location', 'when'],
    );
  },
};
