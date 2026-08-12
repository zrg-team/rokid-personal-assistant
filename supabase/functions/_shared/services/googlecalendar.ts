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
  aliases: ['calendar', 'lich', 'agenda'],
  summary: 'Read your day, answer calendar questions, and add events',
  category: 'Productivity',
  icon: '📅',
  tools: [
    { name: LIST, risk: 'read' },
    { name: QUICK_ADD, risk: 'self' },
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
