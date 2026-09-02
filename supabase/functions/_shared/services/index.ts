/**
 * The service registry — the single source of truth.
 *
 * This replaces two hand-copied copies (config.js CONNECTIONS on the device and
 * a byte-identical duplicate in connections/index.ts) that nothing validated
 * against each other. The device now fetches the compact registry from the
 * `registry` action and caches it, so there is one place a service is defined.
 *
 * Adding a service: write `<slug>.ts`, add one line here. Nothing else.
 */

import type { Adapter } from './types.ts';
import { googlecalendar } from './googlecalendar.ts';
import { gmail } from './gmail.ts';
import { slack } from './slack.ts';
import { googletasks } from './googletasks.ts';
import { notion } from './notion.ts';
import { linear } from './linear.ts';

export const ADAPTERS: Adapter[] = [googlecalendar, gmail, slack, googletasks, notion, linear];

export const BY_SLUG = new Map<string, Adapter>(ADAPTERS.map((a) => [a.slug, a]));

/** tool name → slug, for resolving which adapter owns an execute call. */
export const TOOL_TO_SLUG = new Map<string, string>(
  ADAPTERS.flatMap((a) => a.tools.map((t) => [t.name, a.slug])),
);

/** tool name → risk, for the send gate. */
export const TOOL_RISK = new Map<string, string>(
  ADAPTERS.flatMap((a) => a.tools.map((t) => [t.name, t.risk])),
);

/**
 * The compact registry the glasses fetch and cache. Only what the device needs
 * to display a connection and route an alias — a few hundred bytes, well under
 * the ~10KB fetch ceiling. Tools and risk stay server-side.
 */
export function registryJson() {
  return ADAPTERS.map((a) => ({
    slug: a.slug,
    name: a.name,
    aliases: a.aliases,
    summary: a.summary,
    category: a.category,
    icon: a.icon,
  }));
}

/** The binding a service needs before it can answer, or none. */
export function bindingsFor(slug: string) {
  return BY_SLUG.get(slug)?.bindings || [];
}

/**
 * The tool catalog the CONSOLE renders its action form from.
 *
 * Deliberately separate from `registryJson()`: that one is cached on the
 * glasses and its comment pins it at a few hundred bytes, so tool names, risks
 * and field schemas stay out of it. The console is an authenticated phone
 * surface with no such budget.
 *
 * `outbound` tools are filtered out here rather than hidden in the UI. An alias
 * is a single spoken word with no confirmation step, so "Kavi standup" must not
 * be able to resolve to "send an email" no matter what the console posts — the
 * catalog simply never offers one, and console/index.ts rejects one anyway.
 */
export function toolsJson() {
  return ADAPTERS.map((a) => ({
    slug: a.slug,
    name: a.name,
    icon: a.icon,
    tools: a.tools
      .filter((t) => t.risk !== 'outbound')
      .map((t) => ({
        name: t.name,
        label: t.label || t.name,
        risk: t.risk,
        fields: t.fields || [],
      })),
  }));
}

export type { Adapter } from './types.ts';
export type { Card } from './shape.ts';
