"use client";
import { useEffect, useState } from "react";

const n = (value: unknown) => Number(value || 0);
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function AdminAiDashboard() {
  const [data, setData] = useState<any>(null), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  async function load() { const response = await fetch("/api/admin/ai"); const json = await response.json(); if (!response.ok) throw new Error(json.error); setData(json); }
  useEffect(() => { load().catch(caught => setError(String(caught.message || caught))); }, []);
  if (error) return <main className="admin-shell"><div className="panel ai-recovery">{error}</div></main>;
  if (!data) return <main className="admin-shell"><div className="panel ai-loading">Loading AI economics…</div></main>;
  const t=data.totals,c=data.config,eur=n(t.estimated_cost_usd)*n(c.usd_to_eur),budget=n(c.monthly_budget_eur),percent=budget?Math.min(100,n(data.monthlyCostEur)/budget*100):0;
  async function save(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); setSaving(true); const form=new FormData(event.currentTarget); const body={monthlyBudgetEur:form.get("budget"),perUserLimitEur:form.get("userLimit"),usdToEur:form.get("fx"),primaryProvider:form.get("primaryProvider"),primaryModel:form.get("primaryModel"),fallbackProvider:form.get("fallbackProvider"),fallbackModel:form.get("fallbackModel"),budgetLimitPolicy:form.get("policy"),warningThresholds:[70,90,100]}; const response=await fetch("/api/admin/ai",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); setSaving(false); if(response.ok) await load(); }
  return <main className="admin-shell">
    <header className="page-title"><span>ADMIN · AI USAGE & COST</span><h1>AI economics</h1><p>Last 30 days · costs shown in EUR using configurable USD conversion.</p></header>
    <section className="admin-kpis">
      <div className="panel"><small>Total tokens</small><b>{compact.format(n(t.input_tokens)+n(t.cached_input_tokens)+n(t.output_tokens)+n(t.reasoning_tokens)+n(t.other_billable_tokens))}</b><span>{t.requests} requests</span></div>
      <div className="panel"><small>Estimated cost</small><b>€{eur.toFixed(2)}</b><span>USD ${n(t.estimated_cost_usd).toFixed(2)}</span></div>
      <div className="panel"><small>Reliability</small><b>{t.requests?Math.round(n(t.successes)/n(t.requests)*100):100}%</b><span>{t.failures} errors · {t.retries} retries · {t.fallbacks} fallbacks</span></div>
      <div className="panel"><small>Professor sessions</small><b>{data.sessions.sessions}</b><span>€{(n(data.sessions.average_cost_usd)*n(c.usd_to_eur)).toFixed(3)} average</span></div>
    </section>
    <section className="panel period-strip"><span>Today <b>{compact.format(n(data.periods.today_tokens))}</b></span><span>This week <b>{compact.format(n(data.periods.week_tokens))}</b></span><span>This month <b>{compact.format(n(data.periods.month_tokens))}</b></span><span>Average latency <b>{Math.round(n(t.average_latency_ms))} ms</b></span></section>
    <section className="panel budget-panel"><div><small>MONTHLY PAID-AI BUDGET</small><h2>€{n(data.monthlyCostEur).toFixed(2)} / €{budget.toFixed(2)}</h2></div><div className="budget-track"><span style={{width:`${percent}%`}} /></div><b>{percent.toFixed(0)}%</b></section>
    <section className="admin-grid">
      <div className="panel"><h2>Daily trend</h2><div className="trend-bars">{data.daily.map((row:any)=>{const max=Math.max(1,...data.daily.map((x:any)=>n(x.tokens)));return <div key={row.day} title={`${row.day}: ${row.tokens} tokens`}><span style={{height:`${Math.max(4,n(row.tokens)/max*100)}%`}}/><small>{String(row.day).slice(5)}</small></div>})}</div></div>
      <div className="panel"><h2>Usage by feature</h2><div className="admin-table">{data.byFeature.map((row:any)=><div key={row.name}><span>{row.name}</span><b>{compact.format(n(row.tokens))}</b><small>€{(n(row.cost_usd)*n(c.usd_to_eur)).toFixed(3)}</small></div>)}</div></div>
      <div className="panel"><h2>Provider & model</h2><div className="admin-table">{data.byProvider.map((row:any)=><div key={`${row.provider}-${row.model}`}><span>{row.provider} · {row.model}</span><b>{compact.format(n(row.tokens))}</b><small>{row.errors} errors</small></div>)}</div></div>
      <div className="panel"><h2>Most expensive users</h2><div className="admin-table">{data.byUser.map((row:any)=><div key={row.user_ref}><span>User {row.user_ref}</span><b>{compact.format(n(row.tokens))}</b><small>€{(n(row.cost_usd)*n(c.usd_to_eur)).toFixed(3)}</small></div>)}</div></div>
      <form className="panel admin-controls" onSubmit={save}><h2>Cost controls</h2><label>Monthly budget (€)<input name="budget" type="number" step=".01" defaultValue={c.monthly_budget_eur}/></label><label>Per-user monthly limit (€)<input name="userLimit" type="number" step=".01" defaultValue={c.per_user_monthly_limit_eur}/></label><label>USD → EUR assumption<input name="fx" type="number" step=".0001" defaultValue={c.usd_to_eur}/></label><label>Professor primary provider<input name="primaryProvider" defaultValue={c.professor_primary_provider}/></label><label>Primary model<input name="primaryModel" defaultValue={c.professor_primary_model||""}/></label><label>Fallback provider<input name="fallbackProvider" defaultValue={c.professor_fallback_provider}/></label><label>Fallback model<input name="fallbackModel" defaultValue={c.professor_fallback_model||""}/></label><label>At budget limit<select name="policy" defaultValue={c.budget_limit_policy}><option value="fallback">Use cheaper fallback</option><option value="free">Use free provider</option><option value="disable">Disable paid Professor</option></select></label><button className="primary" disabled={saving}>{saving?"Saving…":"Save controls"}</button></form>
    </section>
  </main>;
}
