/**
 * Google Tasks — the wearer's to-do list, read and added to by voice.
 *
 * The natural companion to the calendar: docs/16 named Tasks and Contacts as
 * the two strongest additions, and Tasks is the one that needs nothing beyond
 * the Google connection the wearer already grants.
 *
 * Every read needs a task list id, which no utterance can supply — "Kavi tasks"
 * cannot name a UUID. So it is a **binding**: chosen once in the console from
 * `GOOGLETASKS_LIST_TASK_LISTS`, stored in `owner_bindings`, and filled in here.
 * Without it `plan()` returns `missingBinding` and the glasses show a
 * needs-setup card rather than a wrong call.
 *
 * Tool slugs and argument names verified against Composio's Google Tasks
 * toolkit documentation. Note the casing is genuinely mixed there — the list
 * tools take `tasklistId`, the insert takes `tasklist_id` — so each is spelled
 * as that tool wants it and not "made consistent".
 */

import type { Adapter, Planned } from './types.ts';
import { ackCard, type Card, listCard } from './shape.ts';

const LIST_TASKS = 'GOOGLETASKS_LIST_TASKS';
const INSERT = 'GOOGLETASKS_INSERT_TASK';
const LIST_TASKLISTS = 'GOOGLETASKS_LIST_TASK_LISTS';

export const googletasks: Adapter = {
  slug: 'googletasks',
  name: 'Google Tasks',
  aliases: ['tasks', 'task', 'todo', 'to do', 'google tasks', 'viec', 'cong viec'],
  summary: 'Read what is on your list, and add to it by voice',
  category: 'Productivity',
  icon: '✅',

  tools: [
    {
      name: LIST_TASKS,
      risk: 'read',
      label: 'List my tasks',
      fields: [
        { key: 'maxResults', label: 'How many at most', type: 'number', default: 10 },
        {
          key: 'showCompleted',
          label: 'Include finished ones',
          type: 'boolean',
          default: false,
        },
      ],
    },
    {
      name: INSERT,
      risk: 'self',
      label: 'Add a task',
      fields: [
        { key: 'title', label: 'What to add', type: 'text', required: true },
        { key: 'notes', label: 'Note', type: 'text' },
        {
          key: '_due',
          label: 'Due',
          type: 'day',
          default: 'today',
          expands: { due: 'start' },
          choices: [
            { value: 'today', label: 'Today' },
            { value: 'tomorrow', label: 'Tomorrow' },
            { value: '+2', label: 'In 2 days' },
            { value: '+7', label: 'In a week' },
            { value: 'monday', label: 'Monday' },
            { value: 'friday', label: 'Friday' },
          ],
        },
      ],
    },
  ],

  bindings: [
    { key: 'tasklist', label: 'Which list', listTool: LIST_TASKLISTS },
  ],

  plan(action: string, bindings: Record<string, string>): Planned | null {
    const a = String(action || '').trim();
    const tasklist = bindings.tasklist || '';

    // "add milk", "remind me to call Tracy" → write to the list.
    if (/^(add|new|create|remind me to|note down|put)\b/i.test(a)) {
      if (!tasklist) return { tool: INSERT, args: {}, risk: 'self', missingBinding: 'tasklist' };
      const title = a.replace(/^(add|new|create|remind me to|note down|put)\s+/i, '').trim();
      return { tool: INSERT, args: { tasklist_id: tasklist, title: title || a }, risk: 'self' };
    }

    if (!tasklist) return { tool: LIST_TASKS, args: {}, risk: 'read', missingBinding: 'tasklist' };
    return {
      tool: LIST_TASKS,
      args: { tasklistId: tasklist, maxResults: 10, showCompleted: false },
      risk: 'read',
    };
  },

  project(tool: string, data: unknown): Card {
    if (tool === INSERT) return ackCard('Added to your list', 'Added it.');
    return listCard(data, 'task', ['title', 'name'], ['due', 'notes', 'status']);
  },
};
