import { useEffect, useState } from 'react';

// The app's re-skinning layer (src/static/skins.json) — lets an operator relabel entities,
// recolor/relabel statuses, and reorder/hide/regroup sidebar screens without touching code.
// See skins.json's own "_readme" and docs/app_flow_blueprint.md for the full shape.
// Fetched once and shared by every island, same module-level-cached-promise pattern as
// lib/i18n.ts's useTranslations() (which this deliberately mirrors rather than introducing a
// second, different shared-state mechanism).

export interface SkinEntity {
  singular: string;
  plural: string;
  // Optional, same idea as a screen/status's i18nKey: when the entity noun hasn't been
  // customized (still "Patient"/"Item"), route it through the existing translations.json
  // entry so a full sentence built around it (e.g. "Add New {entity}") still reads as one
  // properly-translated phrase in Arabic instead of splicing an English noun into it. Omit
  // for a genuinely custom noun — it shows literally, in whichever language it was authored,
  // same graceful-degradation as everywhere else in this file.
  i18nKeySingular?: string;
  i18nKeyPlural?: string;
}

export interface SkinStatusEntry {
  label: string;
  color: string; // one of the pill tokens used everywhere else: ok/warn/danger/info/ghost
  i18nKey?: string;
}

export interface SkinScreen {
  id: string;
  category: string;
  label: string;
  icon?: string;
  enabled?: boolean;
  order?: number;
  i18nKey?: string;
  // Declared dependencies, used by script_lab.js's resolveSkinConfig() to auto-disable this
  // screen if the entity/status group it names stops existing under `entities`/`statuses`.
  // Informational only here — the React side doesn't own sidebar/tab enablement (see
  // skinConfig.ts's module comment); it's typed so callers can see what a screen declares.
  entities?: string[];
  statusGroups?: string[];
}

export interface SkinCategory {
  id: string;
  label: string;
  order?: number;
  i18nKey?: string;
}

export interface SkinConfig {
  workspace?: { label?: string };
  categories?: SkinCategory[];
  screens?: SkinScreen[];
  entities?: Record<string, SkinEntity>;
  statuses?: Record<string, Record<string, SkinStatusEntry>>;
}

let skinConfigPromise: Promise<SkinConfig | null> | null = null;
function loadSkinConfig(): Promise<SkinConfig | null> {
  if (!skinConfigPromise) {
    skinConfigPromise = fetch('/static/skins.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return skinConfigPromise;
}

export function useSkinConfig() {
  const [skin, setSkin] = useState<SkinConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSkinConfig().then((data) => {
      if (!cancelled) setSkin(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { skin };
}

type TFunc = (path: string, fallback: string, vars?: Record<string, string | number>) => string;

// Configured noun for an entity (skins.json's `entities` block), falling back to the
// caller-supplied default if skins.json hasn't loaded yet or doesn't define that entity —
// same missing-key-degrades-to-fallback behavior as t(). Routes through t()/i18nKeySingular
// or i18nKeyPlural when present (see SkinEntity's own comment for why).
// Set of "skin loaded, but this key isn't in it" warnings already logged this page load, so a
// component re-rendering on every keystroke doesn't spam the console with the same message.
const warnedMissingSkinKeys = new Set<string>();
function warnOnceIfConfigLoadedButKeyMissing(skin: SkinConfig | null, present: boolean, key: string) {
  // Only warn once skins.json itself has actually loaded (skin !== null) — before that, every
  // lookup misses by definition and it's not a config problem worth flagging.
  if (skin === null || present || warnedMissingSkinKeys.has(key)) return;
  warnedMissingSkinKeys.add(key);
  console.warn(`skins.json: "${key}" not found — falling back to the hardcoded default label/color for it.`);
}

export function entityLabel(
  skin: SkinConfig | null,
  entityId: string,
  t: TFunc,
  fallback: string,
  opts: { plural?: boolean } = {}
): string {
  const entity = skin?.entities?.[entityId];
  warnOnceIfConfigLoadedButKeyMissing(skin, !!entity, `entities.${entityId}`);
  const rawLabel = (entity ? (opts.plural ? entity.plural : entity.singular) : undefined) || fallback;
  const i18nKey = entity ? (opts.plural ? entity.i18nKeyPlural : entity.i18nKeySingular) : undefined;
  return i18nKey ? t(i18nKey, rawLabel) : rawLabel;
}

// Configured {label, colorClass} for one status value (skins.json's `statuses.<group>`
// block). `colorClass` is a `pill <token>` className token (ok/warn/danger/info/ghost).
// `cssVar` is the same color expressed as a CSS custom-property name for components that
// build `var(--token)` inline styles instead of a `pill` className — two existing rendering
// idioms in this codebase that don't share identical token names (there's a `--muted` custom
// property but no `--ghost`, and `--teal` but no `--info`), bridged here so skins.json only
// has to name one token per status and both idioms still resolve to a real color.
const CSS_VAR_BY_TOKEN: Record<string, string> = { ok: 'ok', warn: 'warn', danger: 'danger', info: 'teal', ghost: 'muted' };

export function statusInfo(
  skin: SkinConfig | null,
  group: string,
  value: string,
  t: TFunc,
  fallback: { label: string; colorClass: string }
): { label: string; colorClass: string; cssVar: string } {
  const entry = skin?.statuses?.[group]?.[value];
  warnOnceIfConfigLoadedButKeyMissing(skin, !!entry, `statuses.${group}.${value}`);
  const colorClass = entry?.color || fallback.colorClass;
  const label = entry ? (entry.i18nKey ? t(entry.i18nKey, entry.label) : entry.label) : fallback.label;
  return { label, colorClass, cssVar: CSS_VAR_BY_TOKEN[colorClass] || colorClass };
}

// Color-only variant for call sites that build a `var(--token)` inline style separately from
// their label text (e.g. a pillClass-style helper called independently of the label one).
export function statusColorCssVar(skin: SkinConfig | null, group: string, value: string, fallbackColorClass: string): string {
  const entry = skin?.statuses?.[group]?.[value];
  warnOnceIfConfigLoadedButKeyMissing(skin, !!entry, `statuses.${group}.${value}`);
  const token = entry?.color || fallbackColorClass;
  return CSS_VAR_BY_TOKEN[token] || token;
}
