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

export const ADAPTERS: Adapter[] = [googlecalendar, gmail, slack];

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

export type { Adapter } from './types.ts';
export type { Card } from './shape.ts';
