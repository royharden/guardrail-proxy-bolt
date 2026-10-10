// Shared screening + decision logic for the Guardrail Proxy edge functions.
// These modules are duplicated per-function directory because Deno edge
// functions cannot import across function folders.

export type Noul = { noul: number };
export type Score = { score: number; confidence: number; legend: string[]; probabilities: number[] };
export type Choice = { choice: string; confidence: number; probabilities: Record<string, number> };
export type JevAnswer = Noul | Score | Choice;

export type InputAnswers = {
  pii: Noul;
  injection: Noul;
  jailbreak: Noul;
  toxicity: Score;
  intent: Choice;
};
export type OutputAnswers = {
  pii_leak: Noul;
  prompt_leak: Noul;
  toxicity: Score;
  off_policy: Noul;
};

export type Stage = 'input' | 'output';

export type PolicyConfig = {
  injectionBlock: number;
  injectionReview: number;
  jailbreakBlock: number;
  jailbreakReview: number;
  toxicityBlock: number;
  toxicityReview: number;
  piiRedact: number;
  piiLeakBlock: number;
  piiLeakReview: number;
  offPolicyBlock: number;
  offPolicyReview: number;
  exfilConfidence: number;
  intentUncertainFlag: boolean;
};

export const DEFAULT_POLICY: PolicyConfig = {
  injectionBlock: 0.8,
  injectionReview: 0.5,
  jailbreakBlock: 0.8,
  jailbreakReview: 0.5,
  toxicityBlock: 2.5,
  toxicityReview: 0.5,
  piiRedact: 0.5,
  piiLeakBlock: 0.8,
  piiLeakReview: 0.5,
  offPolicyBlock: 0.7,
  offPolicyReview: 0.5,
  exfilConfidence: 0.7,
  intentUncertainFlag: true,
};

export const PRESETS: Record<string, PolicyConfig> = {
  Balanced: { ...DEFAULT_POLICY },
  Strict: {
    ...DEFAULT_POLICY,
    injectionBlock: 0.6,
    injectionReview: 0.3,
    jailbreakBlock: 0.6,
    jailbreakReview: 0.3,
    toxicityBlock: 2,
    toxicityReview: 1.2,
    piiRedact: 0.3,
    piiLeakBlock: 0.6,
    piiLeakReview: 0.3,
    offPolicyBlock: 0.5,
    offPolicyReview: 0.3,
    exfilConfidence: 0.5,
  },
  Permissive: {
    ...DEFAULT_POLICY,
    injectionBlock: 0.95,
    injectionReview: 0.8,
    jailbreakBlock: 0.95,
    jailbreakReview: 0.8,
    toxicityBlock: 3,
    toxicityReview: 2,
    piiRedact: 0.7,
    piiLeakBlock: 0.95,
    piiLeakReview: 0.8,
    offPolicyBlock: 0.9,
    offPolicyReview: 0.75,
    exfilConfidence: 0.85,
  },
};

export function isScore(a: JevAnswer): a is Score {
  return typeof (a as Score).score === 'number';
}
export function isChoice(a: JevAnswer): a is Choice {
  return typeof (a as Choice).choice === 'string';
}
export function noulValue(a: JevAnswer | undefined): number {
  if (!a) return 0;
  if (typeof (a as Noul).noul === 'number') return (a as Noul).noul;
  return 0;
}

export type FiredRule = { rule: string; detail: string; severity: 'block' | 'flag' };

type Band = { name: string; value: number; blockAt: number; reviewAt: number; blockDetail: string; flagDetail: string };

function bands(stage: Stage, a: InputAnswers | OutputAnswers, p: PolicyConfig): Band[] {
  if (stage === 'input') {
    const inp = a as InputAnswers;
    return [
      { name: 'injection', value: noulValue(inp.injection), blockAt: p.injectionBlock, reviewAt: p.injectionReview, blockDetail: `injection ${fmt(inp.injection)} >= ${p.injectionBlock}`, flagDetail: `injection ${fmt(inp.injection)} in review band` },
      { name: 'jailbreak', value: noulValue(inp.jailbreak), blockAt: p.jailbreakBlock, reviewAt: p.jailbreakReview, blockDetail: `jailbreak ${fmt(inp.jailbreak)} >= ${p.jailbreakBlock}`, flagDetail: `jailbreak ${fmt(inp.jailbreak)} in review band` },
      { name: 'toxicity', value: isScore(inp.toxicity) ? inp.toxicity.score : 0, blockAt: p.toxicityBlock, reviewAt: p.toxicityReview, blockDetail: `toxicity score ${isScore(inp.toxicity) ? inp.toxicity.score : 0} >= ${p.toxicityBlock}`, flagDetail: `toxicity score in review band` },
    ];
  }
  const out = a as OutputAnswers;
  return [
    { name: 'pii_leak', value: noulValue(out.pii_leak), blockAt: p.piiLeakBlock, reviewAt: p.piiLeakReview, blockDetail: `pii_leak ${fmt(out.pii_leak)} >= ${p.piiLeakBlock}`, flagDetail: `pii_leak ${fmt(out.pii_leak)} in review band` },
    { name: 'off_policy', value: noulValue(out.off_policy), blockAt: p.offPolicyBlock, reviewAt: p.offPolicyReview, blockDetail: `off_policy ${fmt(out.off_policy)} >= ${p.offPolicyBlock}`, flagDetail: `off_policy ${fmt(out.off_policy)} in review band` },
    { name: 'toxicity', value: isScore(out.toxicity) ? out.toxicity.score : 0, blockAt: p.toxicityBlock, reviewAt: p.toxicityReview, blockDetail: `toxicity score >= ${p.toxicityBlock}`, flagDetail: `toxicity score in review band` },
  ];
}

function fmt(a: JevAnswer | undefined): string {
  return a ? noulValue(a).toFixed(2) : '0.00';
}

export type Decision = 'pass' | 'redact' | 'flag' | 'block';

// decide() is a pure function: stage + Jev answers + policy -> decision + fired rules.
export function decide(
  stage: Stage,
  answers: Partial<InputAnswers> & Partial<OutputAnswers>,
  policy: PolicyConfig,
  redactionFoundMatches: boolean,
): { decision: Decision; fired_rules: FiredRule[] } {
  const fired: FiredRule[] = [];

  for (const b of bands(stage, answers as InputAnswers & OutputAnswers, policy)) {
    if (b.value >= b.blockAt) fired.push({ rule: `${b.name}:block`, detail: b.blockDetail, severity: 'block' });
    else if (b.value >= b.reviewAt) fired.push({ rule: `${b.name}:review`, detail: b.flagDetail, severity: 'flag' });
  }

  if (stage === 'input') {
    const inp = answers as InputAnswers;
    if (isChoice(inp.intent) && inp.intent.choice === 'data_exfiltration' && inp.intent.confidence >= policy.exfilConfidence) {
      fired.push({ rule: 'intent:data_exfiltration', detail: `intent=data_exfiltration confidence ${inp.intent.confidence.toFixed(2)} >= ${policy.exfilConfidence}`, severity: 'block' });
    }
    if (isChoice(inp.intent) && inp.intent.choice === 'uncertain' && policy.intentUncertainFlag) {
      fired.push({ rule: 'intent:uncertain', detail: 'intent=uncertain, flagging for human review', severity: 'flag' });
    }
  }
  if (stage === 'output') {
    const out = answers as OutputAnswers;
    const leak = noulValue(out.pii_leak);
    if (leak >= policy.piiLeakReview && leak < policy.piiLeakBlock && redactionFoundMatches) {
      fired.push({ rule: 'pii_leak:credential', detail: `pii_leak ${leak.toFixed(2)} with credential-shaped strings found by redactor`, severity: 'block' });
    }
  }

  const decision: Decision = fired.some((r) => r.severity === 'block')
    ? 'block'
    : fired.some((r) => r.severity === 'flag')
      ? 'flag'
      : stage === 'input' && noulValue((answers as InputAnswers).pii) >= policy.piiRedact && redactionFoundMatches
        ? 'redact'
        : 'pass';

  return { decision, fired_rules: fired };
}
