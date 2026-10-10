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

// Pure client-side mirror of decide() — used by Replay so no Jev call is needed.
export type JevAnswerShape = { noul?: number; score?: number; confidence?: number; choice?: string };

export type Decision = 'pass' | 'redact' | 'flag' | 'block';
export type FiredRule = { rule: string; detail: string; severity: 'block' | 'flag' };

export function decide(
  stage: 'input' | 'output',
  answers: Record<string, JevAnswerShape>,
  p: PolicyConfig,
  credentialLikeFound: boolean,
): { decision: Decision; fired_rules: FiredRule[] } {
  const fired: FiredRule[] = [];
  const noul = (k: string) => answers[k]?.noul ?? 0;

  const bands: Array<[string, number, number, number, string]> = stage === 'input'
    ? [
        ['injection', noul('injection'), p.injectionBlock, p.injectionReview, 'noul'],
        ['jailbreak', noul('jailbreak'), p.jailbreakBlock, p.jailbreakReview, 'noul'],
        ['toxicity', answers.toxicity?.score ?? 0, p.toxicityBlock, p.toxicityReview, 'score'],
      ]
    : [
        ['pii_leak', noul('pii_leak'), p.piiLeakBlock, p.piiLeakReview, 'noul'],
        ['off_policy', noul('off_policy'), p.offPolicyBlock, p.offPolicyReview, 'noul'],
        ['toxicity', answers.toxicity?.score ?? 0, p.toxicityBlock, p.toxicityReview, 'score'],
      ];

  for (const [name, value, blockAt, reviewAt] of bands) {
    if (value >= blockAt) fired.push({ rule: `${name}:block`, detail: `${name} ${value.toFixed(2)} >= ${blockAt}`, severity: 'block' });
    else if (value >= reviewAt) fired.push({ rule: `${name}:review`, detail: `${name} ${value.toFixed(2)} in review band (${reviewAt}–${blockAt})`, severity: 'flag' });
  }

  if (stage === 'input') {
    if (answers.intent?.choice === 'data_exfiltration' && (answers.intent.confidence ?? 0) >= p.exfilConfidence) {
      fired.push({ rule: 'intent:data_exfiltration', detail: `intent=data_exfiltration confidence ${(answers.intent.confidence ?? 0).toFixed(2)} >= ${p.exfilConfidence}`, severity: 'block' });
    }
    if (answers.intent?.choice === 'uncertain' && p.intentUncertainFlag) {
      fired.push({ rule: 'intent:uncertain', detail: 'intent=uncertain, flagging for human review', severity: 'flag' });
    }
  }
  if (stage === 'output') {
    const leak = noul('pii_leak');
    if (leak >= p.piiLeakReview && leak < p.piiLeakBlock && credentialLikeFound) {
      fired.push({ rule: 'pii_leak:credential', detail: `pii_leak ${leak.toFixed(2)} with credential-shaped strings found by redactor`, severity: 'block' });
    }
  }

  const decision: Decision = fired.some((r) => r.severity === 'block')
    ? 'block'
    : fired.some((r) => r.severity === 'flag')
      ? 'flag'
      : stage === 'input' && noul('pii') >= p.piiRedact && credentialLikeFound
        ? 'redact'
        : 'pass';

  return { decision, fired_rules: fired };
}

export const DECISION_STYLES: Record<Decision, string> = {
  pass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  redact: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  flag: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  block: 'bg-red-500/15 text-red-300 border-red-500/40',
};
