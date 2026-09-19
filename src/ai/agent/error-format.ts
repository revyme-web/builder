// src/ai/agent/error-format.ts
//
// The error contract (M3): every failure an agent tool returns is a teaching
// message, not a stack trace. Two formatters + two message builders, all
// PURE (no store, no network) so they are usable from the agent runtime, the
// batch meta-tool, the freeform/MCP whole-file gateways and the sandbox.
//
// Layout rules that hold everywhere in this module:
//   • ADDITIVITY — never replace an existing message's substrings. Frozen
//     tests assert on them (e.g. 'Invalid input' in the zod catch path,
//     the exact {code, message} bounce wire shape). Every formatter either
//     appends to the raw text or passes it through verbatim.
//   • ZOD DETECTION — zod v4 serializes its error as a JSON array of issues
//     in `err.message` (e.g. `[{"code":"invalid_type","path":["node_id"],
//     "message":"Invalid input: expected string, received number"}]`). We
//     detect that shape and wrap it; everything else is not our business.
//   • BUDGET — the envelope for a frequent failure family stays under ~150
//     tokens: short rule, one concrete example, one next action.

export interface ToolErrorContext {
  /** Name of the tool the model was calling (e.g. 'batch') — tailors NEXT ACTION. */
  toolName?: string;
  /** Valid tool names for the unknown-tool failure (batch). */
  validTools?: string[];
}

export interface BouncedViolation {
  code: string;
  message: string;
  tier?: 1 | 2 | 3;
}

/** A parsed zod v4 issue: {code, path: (string|number)[], message, expected?}. */
interface ZodIssue {
  code: string;
  path: Array<string | number>;
  message: string;
  expected?: string;
}

/** True when `err.message` is zod v4's JSON-serialized issue array. */
function parseZodIssues(err: unknown): ZodIssue[] | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message;
  if (typeof msg !== 'string' || !msg.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(msg);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const issues = (parsed as ZodIssue[]).filter(
      (i) => i !== null && typeof i === 'object'
        && typeof (i as ZodIssue).code === 'string'
        && Array.isArray((i as ZodIssue).path)
        && typeof (i as ZodIssue).message === 'string',
    );
    return issues.length > 0 ? issues : null;
  } catch {
    return null;
  }
}

/** `["node_id"]` → `node_id`; `[0,"tool"]` → `operations[0].tool`. */
function formatIssuePath(issue: ZodIssue): string {
  let out = '';
  for (const seg of issue.path) out += typeof seg === 'number' ? `[${seg}]` : (out === '' ? seg : `.${seg}`);
  return out || '(root)';
}

function expectedWord(expected: string | undefined): string {
  switch (expected) {
    case 'string': return 'a string';
    case 'number': return 'a number';
    case 'boolean': return 'a boolean';
    case 'object': return 'an object';
    case 'array': return 'an array';
    case 'null': return 'null';
    default: return 'the declared type';
  }
}

/** The REVYME RULE / USE INSTEAD lines for the family the failure belongs to
 *  (matched on the issue path — the zod key the model got wrong). */
function envelopeForPath(
  issuePath: string,
  ctx: ToolErrorContext,
): { rule: string; useInstead: string } {
  const lower = issuePath.toLowerCase();
  if (lower.includes('styles') || lower.includes('attrs')) {
    return {
      rule: 'Style and attr values are plain objects of camelCase string values.',
      useInstead: 'styles: { backgroundColor: \'#6366f1\', padding: \'24px\' }',
    };
  }
  if (lower.includes('operations') || lower.includes('args') || lower.includes('tool')) {
    return {
      rule: 'batch operations are {tool, args} pairs — one semantic tool per operation.',
      useInstead: 'operations: [{ tool: \'set_styles\', args: { node_id: \'hero\', styles: { color: \'red\' } } }]',
    };
  }
  if (lower.includes('viewport')) {
    return {
      rule: 'Viewport tools take a viewport id (\'desktop\', \'tablet\', \'mobile\', a custom id) or a width in px.',
      useInstead: 'viewport: 768   // tablet — or "tablet"',
    };
  }
  if (lower.includes('node_id') || lower.includes('parent_id') || lower.includes('id')) {
    return {
      rule: 'Ids are the element\'s data-id, read from the page tree (or returned by a creating tool).',
      useInstead: 'node_id: \'hero-cta\'',
    };
  }
  return {
    rule: 'Tool arguments are plain JSON values — strings quoted, arrays bracketed, objects braced.',
    useInstead: 'a plain JSON value of the declared type',
  };
}

function nextActionFor(ctx: ToolErrorContext): string {
  if (ctx.toolName === 'batch') return 'Re-issue `batch` with corrected operations.';
  return 'Re-issue the tool call with corrected arguments.';
}

/**
 * Format ANY error thrown while validating/executing an agent tool. zod v4
 * failures get the teaching envelope (the raw serialized message is kept
 * unchanged first — frozen tests assert on 'Invalid input'); every other
 * error passes through verbatim.
 */
export function formatToolError(err: unknown, ctx: ToolErrorContext = {}): string {
  const issues = parseZodIssues(err);
  if (!issues) {
    return err instanceof Error ? err.message : String(err);
  }

  const shown = issues.slice(0, 2);
  const more = issues.length - shown.length;
  const lines: string[] = [issues.length > 0 ? issues.map((i) => i.message).join('\n') : ''];
  for (const issue of shown) {
    const pathLabel = formatIssuePath(issue);
    const { rule, useInstead } = envelopeForPath(pathLabel, ctx);
    lines.push(
      `PROBLEM: ${pathLabel} must be ${expectedWord(issue.expected)}.`,
      `REVYME RULE: ${rule}`,
      `USE INSTEAD: ${useInstead}`,
    );
  }
  if (more > 0) lines.push(`…and ${more} more invalid field${more === 1 ? '' : 's'}.`);
  lines.push(`NEXT ACTION: ${nextActionFor(ctx)}`);
  return lines.join('\n');
}

// ─── Oracle bounce envelopes ───────────────────────────────────────────────
//
// formatOracleBounce enriches registered grain-level rules with the exact
// dialect to write INSTEAD. Codes NOT in the registry pass through verbatim —
// this is load-bearing: the wire shape for unknown codes is frozen
// (formatBounce([{code:'X', message:'m'}]) equals exactly that), and dozens
// of teaching messages (FORBIDDEN_IMPORT, MISSING_DATA_ID, STALE_FILE, …)
// must reach the model untouched.

interface OracleRule {
  /** One-line framing of what the oracle rule guards. */
  rule: string;
  /** The concrete dialect to write instead. */
  useInstead: string;
}

/** Code → rule map for the oracle violations the agent must bounce back with
 *  the builder's motion/identifier dialect. TRANSPARENT_COLOR and
 *  NODE_MISSING_POSITION are intentionally NOT here (their messages are
 *  already the fix instruction; zero priority). */
export const ORACLE_RULES: Record<string, OracleRule> = {
  CSS_TRANSITION: {
    rule: 'CSS transitions do not exist in a Revyme page — motion timing is MotionConfig-owned and editable in the Animation panel.',
    useInstead: 'An entrance: initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}. A hover/tap: whileHover={{ scale: 1.05 }}. A loop: animate={{ scale: 1.1 }} transition={{ duration: 1, repeat: Infinity, repeatType: \'mirror\' }}.',
  },
  CSS_KEYFRAMES_ANIMATION: {
    rule: 'CSS @keyframes are invisible to the Animation panel — motion is framer-motion props.',
    useInstead: 'appear with initial/whileInView (viewport={{ once: true }}), states with variants, scroll with useScroll/useTransform — never a CSS animation string.',
  },
  BARE_ANIMATE_OBJECT: {
    rule: 'A bare animate={{…}} without repeat reads as a broken Loop.',
    useInstead: 'Entrance: initial={{…from…}} whileInView={{…to…}} viewport={{ once: true }} transition={{…}}. Loop: animate={{ scale: 1.2 }} transition={{ duration: 1, repeat: Infinity, repeatType: \'mirror\' }}.',
  },
  PIN_VALUE_NOT_PX: {
    rule: 'Offset pins must be px strings — the Position tool\'s pin detector only matches "<n>px", so a bare number shows as unset and gets rewritten on the first drag.',
    useInstead: 'top: \'64px\', left: \'24px\' — never a bare 64, never \'10%\' on left/top (its only % is the centering pattern with translate).',
  },
  PIN_PERCENT_RIGHT_BOTTOM: {
    rule: 'right/bottom pins resolve only in px — a percentage is ignored by the canvas and overwritten on the first drag.',
    useInstead: 'right: \'32px\', bottom: \'16px\' — or anchor from the other edge with left/top (which accept %).',
  },
  WOULD_CRASH: {
    rule: 'The file would crash at runtime — every referenced identifier must resolve.',
    useInstead: 'Reference ONLY identifiers declared in this file or explicitly imported; remove or declare the offender, then return the complete corrected file.',
  },
};

/**
 * Wrap oracle violations for the wire (freeform bounce, MCP submit bounced,
 * whole-file). Returns {code, message} pairs; registered codes gain the
 * USE INSTEAD dialect block appended to their message.
 */
export function formatOracleBounce(violations: ReadonlyArray<BouncedViolation>): Array<{ code: string; message: string }> {
  return violations.map((v) => {
    const rule = ORACLE_RULES[v.code];
    if (!rule) return { code: v.code, message: v.message };
    return {
      code: v.code,
      message: `${v.message}\nUSE INSTEAD: ${rule.rule} ${rule.useInstead}`,
    };
  });
}

/**
 * The batch unknown-tool reason: names the op, then lists what IS valid.
 * The batch's per-op result item keeps the frozen short 'Unknown tool' —
 * this richer form is what reaches the model via the rollback `reason`.
 */
export function formatUnknownTool(toolName: string, validTools: string[]): string {
  const list = validTools.length > 0 ? validTools.join(', ') : '(none)';
  return `Unknown tool "${toolName}". Valid tools: ${list}.`;
}

/**
 * Node-not-found failure — appends the ~cap closest data-ids so the model can
 * re-issue against a real id. Falls back to the exact original message when
 * there is nothing useful to add (empty project).
 */
export function formatNodeNotFound(nodeId: string, allIds: Iterable<string>, cap = 10): string {
  const ids = [...allIds].filter((x) => x !== nodeId).sort();
  if (ids.length === 0) return `Node "${nodeId}" not found.`;
  const shown = ids.slice(0, cap);
  const more = ids.length - shown.length;
  return `Node "${nodeId}" not found. Valid ids: ${shown.join(', ')}${more > 0 ? `, …(+${more} more)` : ''}.`;
}