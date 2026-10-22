'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CardHeader, CardTitle, Empty, Input, Label } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { usd } from '@/lib/utils';

interface Usage {
  analyzer: string;
  spentUsd: number;
  limitUsd: number;
  prices: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  bySession: {
    id: string;
    title: string;
    analyzer: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    segments: number;
    analyses: number;
    skipped: number;
    retrievals: number;
    cacheHits: number;
    suggestions: number;
    dismissed: number;
    confirmedMisunderstandings: number;
    costPerSuggestion: number | null;
    costPerConfirmedMisunderstanding: number | null;
  }[];
  byOperation: { operation: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[];
}

export default function CostPage() {
  const [data, setData] = useState<Usage | null>(null);
  const [budget, setBudget] = useState('');
  const [retention, setRetention] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const u = await api<Usage>('/api/usage');
    setData(u);
    setBudget(String(u.limitUsd));
    const d = await api<{ settings: { transcriptRetentionDays: number | null } }>('/api/dashboard');
    setRetention(d.settings.transcriptRetentionDays ? String(d.settings.transcriptRetentionDays) : '');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const r = await api<{ purgedSegments: number }>('/api/settings', {
      method: 'PATCH',
      body: { monthlyBudgetUsd: Number(budget), transcriptRetentionDays: retention ? Number(retention) : null },
    });
    setMsg(`Saved${r.purgedSegments ? ` · ${r.purgedSegments} expired transcript segments deleted` : ''}`);
    await load();
  };

  if (!data) return <p className="text-sm text-[var(--color-muted)]">Loading…</p>;
  const tokens = (n: number) => n.toLocaleString();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Cost &amp; activity</h1>
        <Badge tone={data.analyzer === 'llm' ? 'accent' : 'neutral'}>analyzer: {data.analyzer}</Badge>
      </div>
      {data.analyzer !== 'llm' && (
        <p className="text-sm text-[var(--color-muted)]">
          The heuristic analyzer makes no model calls, so token counts are zero. Set <code>OPENAI_API_KEY</code> and <code>ANALYZER=llm</code> to measure model usage.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle>By operation</CardTitle>
          </CardHeader>
          {data.byOperation.length === 0 ? (
            <Empty>No model calls recorded.</Empty>
          ) : (
            <Table
              head={['Operation', 'Model', 'Calls', 'Input tok', 'Output tok', 'Est. cost']}
              rows={data.byOperation.map((o) => [o.operation, o.model, o.calls, tokens(o.inputTokens), tokens(o.outputTokens), usd(o.costUsd)])}
            />
          )}
        </Card>
        <Card className="space-y-3 p-4">
          <div>
            <div className="text-xs text-[var(--color-muted)]">Spent this month</div>
            <div className="text-lg font-semibold tabular-nums">
              {usd(data.spentUsd)} <span className="text-sm font-normal text-[var(--color-muted)]">of {usd(data.limitUsd)}</span>
            </div>
            <p className="text-xs text-[var(--color-muted)]">Analysis stops for the workspace when the budget is reached.</p>
          </div>
          <div>
            <Label htmlFor="budget">Monthly budget (USD)</Label>
            <Input id="budget" type="number" min={0} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="retention">Delete transcripts after (days, blank = keep)</Label>
            <Input id="retention" type="number" min={1} value={retention} onChange={(e) => setRetention(e.target.value)} />
          </div>
          <Button variant="primary" size="sm" onClick={save}>
            Save settings
          </Button>
          {msg && <p className="text-xs text-[var(--color-muted)]">{msg}</p>}
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By session</CardTitle>
        </CardHeader>
        {data.bySession.length === 0 ? (
          <Empty>No sessions yet.</Empty>
        ) : (
          <Table
            head={['Session', 'Segments', 'Analyses', 'Skipped', 'Retrievals (cached)', 'Model calls', 'Tokens in/out', 'Cost', 'Suggestions', 'Dismissed', 'Confirmed misunderstandings', 'Cost / suggestion', 'Cost / confirmed']}
            rows={data.bySession.map((s) => [
              s.title,
              s.segments,
              s.analyses,
              s.skipped,
              `${s.retrievals} (${s.cacheHits})`,
              s.calls,
              `${tokens(s.inputTokens)} / ${tokens(s.outputTokens)}`,
              usd(s.costUsd),
              s.suggestions,
              s.dismissed,
              s.confirmedMisunderstandings,
              s.costPerSuggestion === null ? '—' : usd(s.costPerSuggestion),
              s.costPerConfirmedMisunderstanding === null ? '—' : usd(s.costPerConfirmedMisunderstanding),
            ])}
          />
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Price table used for estimates</CardTitle>
        </CardHeader>
        <p className="px-4 pt-3 text-xs text-[var(--color-muted)]">Prices change. These are estimates only; override them with UC_MODEL_PRICES_JSON.</p>
        <Table head={['Model', 'Input $/MTok', 'Output $/MTok']} rows={Object.entries(data.prices).map(([m, p]) => [m, p.inputPerMTok, p.outputPerMTok])} />
      </Card>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--color-muted)]">
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="whitespace-nowrap px-4 py-2 tabular-nums">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
