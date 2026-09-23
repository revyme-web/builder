// src/ai/agent/tools/coerce.ts
//
// Coercition des entrées MODÈLE — le pattern « réparer comme un navigateur »
// documenté par the reference builder (« If you can repair those mistakes the way a browser
// repairs broken HTML, the speed gain is worth it »). Les modèles, surtout les
// petits (glm-4.7-flash observé en E2E réel 2026-08-15), sérialisent les
// objets imbriqués en JSON STRINGS (`styles: "{\"padding\": \"64px\"}"`),
// utilisent des nombres pour des valeurs CSS (`padding: 64`) et inventent des
// formes alternatives pour le shape du batch (`{op: ...}`, `{operation: ...}`,
// `{add_node: {...}}`). Au lieu de rejeter le tool_call (zod), on RÉPARE
// l'entrée au plus près du schéma attendu.
//
// Règle : la coercition est PERMISSIVE sur la forme, jamais sur l'intention —
// une valeur réparée doit rester ce que le modèle voulait dire. Ce qui n'est
// pas réparable est laissé tel quel (le zod du schéma le rejettera avec un
// message précis).

/** Scalaire → chaîne CSS-safe : nombres et booléens passent en string
 *  (`64` → `"64"`), tout le reste est rejeté (null/objets/tableaux). */
function scalarToString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

/** Parse une chaîne JSON en conservant les objets/tableaux ; null sinon. */
function tryParseJson(v: string): unknown {
  try {
    const parsed = JSON.parse(v);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Répare une valeur attendue comme Record<string, string> (styles, attrs) :
 * - string JSON (`"{\"padding\":\"64px\"}"`) → parse → récurse ;
 * - objet avec valeurs scalaires → String(v) ; null/undefined → retiré ;
 *   objets/tableaux imbriqués → retirés (une valeur de style n'est jamais
 *   un objet) ;
 * - toute autre forme → {} (vide, jamais un throw).
 */
export function coerceRecord(v: unknown): Record<string, string> {
  if (typeof v === 'string') {
    const parsed = tryParseJson(v);
    return parsed !== null ? coerceRecord(parsed) : {};
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(v)) {
      const scalar = scalarToString(value);
      if (scalar !== null) out[key] = scalar;
    }
    return out;
  }
  return {};
}

/**
 * Normalise un élément d'opération du batch vers LA forme canonique
 * `{ tool, args, ref_id? }`. Le modèle invente des variantes (observées en
 * réel) :
 *   { tool, args, ref_id }                     → canonique (inchangé)
 *   { op: 'add_node', parent_id, styles, ... } → tool=op, args=reste
 *   { operation: 'add_node', args }            → tool=operation, args
 *   { operation: 'add_node', parent_id, ... }  → tool=operation, args=reste
 *   { name: 'add_node', args }                 → tool=name, args
 *   { add_node: { parent_id, ... } }           → tool=clé unique, args=valeur
 * Une forme non inférable (op sans nom de tool) est laissée telle quelle :
 * le zod la rejette avec un message clair.
 */
export function normalizeBatchOp(op: unknown): unknown {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) return op;
  const o = op as Record<string, unknown>;

  const argsOf = (args: unknown): unknown => {
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
      const a = args as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(a)) {
        if (key === 'styles') out.styles = coerceRecord(value);
        else if (key === 'attrs') out.attrs = coerceRecord(value);
        else out[key] = value;
      }
      return out;
    }
    return args;
  };

  const restOf = (skip: Set<string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(o)) {
      if (skip.has(key)) continue;
      if (key === 'styles') out.styles = coerceRecord(value);
      else if (key === 'attrs') out.attrs = coerceRecord(value);
      else out[key] = value;
    }
    return out;
  };

  if (typeof o.tool === 'string') {
    return { tool: o.tool, args: argsOf(o.args), ...(o.ref_id !== undefined ? { ref_id: o.ref_id } : {}) };
  }
  if (typeof o.op === 'string') {
    return { tool: o.op, args: restOf(new Set(['op', 'ref_id'])), ...(o.ref_id !== undefined ? { ref_id: o.ref_id } : {}) };
  }
  if (typeof o.operation === 'string') {
    if (o.args !== undefined) {
      return { tool: o.operation, args: argsOf(o.args), ...(o.ref_id !== undefined ? { ref_id: o.ref_id } : {}) };
    }
    return { tool: o.operation, args: restOf(new Set(['operation', 'ref_id'])), ...(o.ref_id !== undefined ? { ref_id: o.ref_id } : {}) };
  }
  if (typeof o.name === 'string' && o.args !== undefined) {
    return { tool: o.name, args: argsOf(o.args), ...(o.ref_id !== undefined ? { ref_id: o.ref_id } : {}) };
  }
  const keys = Object.keys(o);
  if (keys.length === 1 && typeof o[keys[0]] === 'object' && o[keys[0]] !== null && !Array.isArray(o[keys[0]])) {
    const args = argsOf(o[keys[0]]);
    return { tool: keys[0], args: args ?? {} };
  }
  // Forme APLATIE sans nom de tool (observée en réel : le modèle liste des
  // définitions de nœuds directement). L'intention est inférable par la forme :
  //   {tag, parent_id, ...}          → add_node (définition de nœud)
  //   {node_id, styles}              → set_styles
  //   {node_id, attrs}               → set_attr
  //   {node_id, text}                → set_text
  // Une inférence fausse est sans gravité : le tool imbriqué échoue, le bulk
  // est rollbacké avec un message clair, le modèle corrige.
  if (typeof o.tag === 'string' && typeof o.node_id !== 'string') {
    return { tool: 'add_node', args: restOf(new Set(['ref_id'])), ...(o.ref_id !== undefined ? { ref_id: o.ref_id } : {}) };
  }
  if (typeof o.node_id === 'string') {
    const args = restOf(new Set(['ref_id']));
    if (typeof args.styles === 'object') return { tool: 'set_styles', args, ...(o.ref_id !== undefined ? { ref_id: o.ref_id } : {}) };
    if (typeof args.attrs === 'object') return { tool: 'set_attr', args, ...(o.ref_id !== undefined ? { ref_id: o.ref_id } : {}) };
    if (typeof args.text === 'string') return { tool: 'set_text', args, ...(o.ref_id !== undefined ? { ref_id: o.ref_id } : {}) };
  }
  return op;
}

/** Applique normalizeBatchOp à chaque élément d'une liste d'opérations. */
export function coerceBatchOps(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeBatchOp);
  return v;
}
