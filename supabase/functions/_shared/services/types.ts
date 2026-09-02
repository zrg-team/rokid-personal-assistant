/**
 * The service adapter contract.
 *
 * Adding a connected service is ONE file in this directory implementing this
 * interface, plus one line in `index.ts`, plus its OAuth auth config in the
 * Composio dashboard — and a deploy. No edit to the router, the registry
 * duplicate, or the render branches, because those no longer exist: this
 * directory IS the registry, and `project()` replaces the client-side render.
 */

import type { Card } from './shape.ts';

/**
 * A tool's risk class — what the send gate does with it.
 *
 * Replaces the old `kind` (read/write/send), which was declared 13× and read at
 * zero call sites, so nothing was ever confirmed. Enforced server-side in the
 * connections function, so a repacked .aix cannot skip it.
 *
 *   read     — pure read. Execute and render.
 *   self     — a write to the wearer's OWN data (a reminder, a note). Execute
 *              immediately; a confirmation on the highest-frequency verb would
 *              kill it. Offer an undo where one is possible.
 *   outbound — sends something to someone else (an email, a Slack message).
 *              NEVER executes on the first turn; the gate stages it.
 */
export type Risk = 'read' | 'self' | 'outbound';

export type FieldType = 'text' | 'number' | 'boolean' | 'choice' | 'day';

/**
 * One control on the console's action form.
 *
 * Declared next to the tool so a new service's form appears the moment its
 * adapter describes it — the console renders these generically and knows
 * nothing about calendars, mail or channels.
 *
 * `key` is the Composio argument name, declared here once. That matters more
 * than it looks: the argument names for these tools were previously spelled out
 * in `plan()`, in `utils/calendar.js`, and nowhere else, and Composio's own
 * published schema disagrees with itself about camelCase vs snake_case.
 */
export interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** May itself be a placeholder, e.g. '{{day:today}}'. */
  default?: unknown;
  choices?: { value: string; label: string }[];
  /**
   * A `day` field that feeds SEVERAL arguments. The console shows one day
   * picker and writes each entry as its own argument, so "which day" produces
   * both a time_min and a time_max without the form knowing why.
   *
   *   expands: { time_min: 'start', time_max: 'end' }
   *     -> { time_min: '{{start:tomorrow}}', time_max: '{{end:tomorrow}}' }
   *
   * A field whose key starts with `_` is a control only and never becomes an
   * argument on its own.
   */
  expands?: Record<string, 'day' | 'start' | 'end'>;
}

export interface ToolDecl {
  name: string;
  risk: Risk;
  /** What the console calls it. Falls back to `name`. */
  label?: string;
  /** The form. A tool with none simply offers no options. */
  fields?: Field[];
}

/**
 * An opaque per-owner resource id the wearer chooses once at connect time — a
 * Slack channel, a Tasks list, a Linear team. Not derivable from an utterance,
 * so the console renders one picker per binding and stores the choice in
 * `owner_bindings`. `list` enumerates the options.
 */
export interface Binding {
  key: string;
  label: string;
  /** The tool that lists the options, e.g. SLACK_LIST_ALL_CHANNELS. */
  listTool: string;
}

export interface Planned {
  tool: string;
  args: Record<string, unknown>;
  /** The risk of the chosen tool, copied through so the gate need not re-look-up. */
  risk: Risk;
  /**
   * A required binding this call needs but did not have. When set, the caller
   * renders a `needs-setup` card instead of executing — never a wrong call.
   */
  missingBinding?: string;
}

export interface Adapter {
  slug: string;                 // = Composio toolkit slug
  name: string;
  aliases: string[];            // folded match targets for "Kavi <alias> <action>"
  summary: string;
  category: string;
  icon: string;
  tools: ToolDecl[];
  bindings?: Binding[];

  /**
   * Map a spoken action to a tool call, given the owner's resolved bindings.
   * Returns null if this adapter cannot serve the action at all.
   */
  plan(action: string, bindings: Record<string, string>): Planned | null;

  /** Shape a Composio result for `tool` into a ≤4-row card. */
  project(tool: string, data: unknown): Card;
}
