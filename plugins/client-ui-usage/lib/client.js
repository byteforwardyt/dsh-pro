/**
 * Usage settings page — browser half.
 *
 * Recorded usage from the harness's readable session logs. The host replaces
 * repeated samples per turn/step and includes uncached input, output, cache
 * reads, and cache writes. Calls without reported usage cannot be inferred.
 *
 * The recorded history below is separate from connected-account plan meters. Tokens spent is a fact a session log can
 * prove; "62% of your ChatGPT plan" is not. Conflating the
 * two would mean inventing a denominator, so the quota section uses only direct provider reports.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { AccountUsage } = require("@dsh-desktop/client-ui-accounts");
    const { useState, useEffect, useMemo, useCallback, useRef } = React;
    const h = React.createElement;

    const ENDPOINT = "/dsh-auth/usage";
    const tokenTotal = (row) => row.input + row.output + (row.cacheRead || 0) + (row.cacheWrite || 0);
    function validSummary(data) {
      const count = (n) => Number.isSafeInteger(n) && n >= 0;
      const buckets = (row) => row && count(row.input) && count(row.output) && count(row.turns)
        && (row.cacheRead === undefined || count(row.cacheRead)) && (row.cacheWrite === undefined || count(row.cacheWrite));
      const coverage = data?.coverage;
      return data && buckets(data.totals) && count(data.totals.sessions)
        && (coverage === undefined || (coverage && typeof coverage.complete === "boolean"
          && [coverage.read, coverage.partial, coverage.skipped, coverage.unavailable].every(count)
          && coverage.issues && ["oversized", "unreadable", "corrupt", "truncated", "ambiguous", "invalidUsage"].every(key => count(coverage.issues[key]))))
        && [data.totals.firstAt, data.totals.lastAt].every(n => n == null || (typeof n === "number" && Number.isFinite(new Date(n).getTime())))
        && Array.isArray(data.models) && data.models.every(row => buckets(row) && typeof row.provider === "string" && typeof row.model === "string")
        && Array.isArray(data.days) && data.days.every(row => buckets(row) && typeof row.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.day))
        && Array.isArray(data.hours) && data.hours.length === 24 && data.hours.every(count);
    }

    /** Short, human provider names; the route ids are catalog-shaped. */
    const PROVIDER = {
      "openai-codex": "ChatGPT",
      xai: "Grok",
      openrouter: "OpenRouter",
      "kimi-coding": "Kimi",
      anthropic: "Claude",
      unknown: "Unknown",
    };

    function compact(n) {
      if (typeof n !== "number" || !isFinite(n)) return "0";
      const a = Math.abs(n);
      if (a < 1000) return String(n);
      // The unit thresholds account for rounding: a value in [999500, 1e6)
      // rounds to "1000K", which should read "1.0M" — so it belongs to the next
      // unit up. Likewise [999500000, 1e9) rounds into "B".
      if (a < 999500) return (n / 1000).toFixed(a < 10000 ? 1 : 0) + "K";
      if (a < 999500000) return (n / 1000000).toFixed(a < 10000000 ? 1 : 0) + "M";
      return (n / 1000000000).toFixed(1) + "B";
    }

    const CSS = `.dshd-us{container:usage-page / inline-size;display:flex;flex-direction:column;gap:28px;max-width:100%;min-width:0;--usage-input:#8fa9e8;--usage-output:#b496dc;--usage-cache:var(--dshd-good,#73c99b);--usage-write:var(--dshd-warn,#e8b16c)}
.dshd-us h2{font:500 16px/24px -apple-system,BlinkMacSystemFont,sans-serif;margin:0 0 4px;color:var(--dsw-alias-label-primary)}
.dshd-us p.intro,.dshd-us-caption{font-size:12px;line-height:1.7;margin:0;color:var(--dsw-alias-label-tertiary)}
.dshd-us-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.dshd-us-head>span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshd-us-refresh{padding:7px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}.dshd-us-refresh:disabled{opacity:.5;cursor:default}
.dshd-us-hero{padding:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:linear-gradient(125deg,color-mix(in srgb,var(--usage-cache) 7%,transparent),transparent 65%);display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center}.dshd-us-hero small{color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:1.2px;text-transform:uppercase}.dshd-us-hero strong{display:block;font-size:40px;font-weight:500;letter-spacing:-1.5px;line-height:1.3;margin:8px 0}.dshd-us-hero svg{color:var(--usage-cache);width:44px;height:44px;opacity:.75}
.dshd-us-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-border-l2)}.dshd-us-tile{padding:16px;background:var(--dsw-alias-bg-base);min-width:0}.dshd-us-tile b{display:block;font-size:22px;font-weight:500;line-height:1.5;letter-spacing:-.5px;color:var(--dsw-alias-label-primary)}.dshd-us-tile span{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.dshd-us-tile[data-tone=good] b{color:var(--usage-cache)}
.dshd-us-section{padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;min-width:0}.dshd-us-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}.dshd-us-section-head input{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:7px;padding:7px 10px;color:inherit;font:inherit;font-size:12px;max-width:100%;box-sizing:border-box}
.dshd-us-cal{display:flex;gap:10px;align-items:flex-start;container-type:inline-size;--heat-cell:max(20px,calc((100cqw - 42px - 100px)/26))}.dshd-us-cal-scroll{flex:1;min-width:0;overflow-x:auto;padding:2px 0 6px}.dshd-us-days{display:flex;flex-direction:column;gap:4px;flex:none;padding-top:28px;width:32px}.dshd-us-days span{height:var(--heat-cell);line-height:var(--heat-cell);font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right}.dshd-us-months,.dshd-us-heat{display:grid;grid-template-columns:repeat(26,minmax(20px,1fr));gap:4px;min-width:620px}.dshd-us-months{height:18px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:8px}.dshd-us-months span{min-width:0}.dshd-us-week{display:flex;flex-direction:column;gap:4px;min-width:0}.dshd-us-cell{width:100%;aspect-ratio:1;border-radius:4px;flex:none;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}.dshd-us-cell[data-level="1"]{background:color-mix(in srgb,var(--usage-cache) 25%,transparent)}.dshd-us-cell[data-level="2"]{background:color-mix(in srgb,var(--usage-cache) 45%,transparent)}.dshd-us-cell[data-level="3"]{background:color-mix(in srgb,var(--usage-cache) 70%,transparent)}.dshd-us-cell[data-level="4"]{background:var(--usage-cache)}.dshd-us-legend{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dshd-us-hourly{height:100px;display:grid;grid-template-columns:repeat(24,minmax(0,1fr));align-items:end;gap:4px;margin-top:20px}.dshd-us-hourly>div{height:100%;display:flex;align-items:end;position:relative}.dshd-us-hourly i{display:block;width:100%;min-height:2px;border-radius:3px 3px 0 0;background:color-mix(in srgb,var(--usage-input) 65%,transparent)}.dshd-us-hour-axis{display:flex;justify-content:space-between;margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:10px}
.dshd-us-rows{display:flex;flex-direction:column;gap:18px}.dshd-us-row{display:flex;flex-direction:column;gap:9px}.dshd-us-row+.dshd-us-row{border-top:1px solid var(--dsw-alias-border-l1);padding-top:18px}.dshd-us-rowhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;overflow-wrap:anywhere;font-size:13px}.dshd-us-rowhead b{font-weight:500}.dshd-us-rowhead .prov{color:var(--dsw-alias-label-tertiary);font-size:11px}.dshd-us-rowhead .tot{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px}.dshd-us-split{display:flex;height:6px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-border-l2)}.dshd-us-split i{display:block;height:100%}.dshd-us-split .in{background:var(--usage-input)}.dshd-us-split .out{background:var(--usage-output)}.dshd-us-split .read{background:var(--usage-cache)}.dshd-us-split .write{background:var(--usage-write)}.dshd-us-sub{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.dshd-us-key{display:inline-flex;align-items:center;gap:5px}.dshd-us-key i{width:7px;height:7px;border-radius:2px;display:inline-block}
.dshd-us-table-scroll{overflow:auto;max-height:360px}.dshd-us table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}.dshd-us th{font-weight:400;font-size:10px;color:var(--dsw-alias-label-tertiary);position:sticky;top:0;background:var(--dsw-alias-bg-base)}.dshd-us td,.dshd-us th{padding:10px 12px;text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1)}.dshd-us td:first-child,.dshd-us th:first-child{text-align:left;padding-left:0}.dshd-us td:last-child,.dshd-us th:last-child{padding-right:0}.dshd-us details>summary{cursor:pointer;font-size:13px;margin-bottom:14px}.dshd-us-empty,.dshd-us-coverage{padding:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}.dshd-us-coverage{border-left:3px solid var(--usage-write)}.dshd-us-coverage p{margin:4px 0}.dshd-us [role=alert]{color:var(--dshd-bad,#ed8790)}.dshd-us button:focus-visible,.dshd-us input:focus-visible,.dshd-us [tabindex]:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:3px}
@container usage-page (max-width:650px){.dshd-us-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.dshd-us-section,.dshd-us-hero{padding:16px}.dshd-us-hero strong{font-size:32px}.dshd-us-hourly{gap:2px}.dshd-us{gap:20px}}
@container usage-page (max-width:380px){.dshd-us-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.dshd-us-tile{padding:12px}.dshd-us-tile b{font-size:18px}.dshd-us-hero strong{font-size:28px}.dshd-us-section-head input{width:100%}}
`;

    const STYLE_ID = "dshd-usage-style";
    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /**
     * A GitHub-style calendar: one column per week, Sunday at the top, the last
     * 26 weeks. Levels are quartiles of the non-zero days rather than fractions
     * of the maximum, so one enormous day does not flatten every other day to
     * the lightest shade.
     */
    function HeatMap({ days }) {
      const grid = useMemo(() => {
        const byDay = new Map(days.map((d) => [d.day, d]));
        const totals = days.map(tokenTotal).filter((n) => n > 0).sort((a, b) => a - b);
        const quartile = (q) => (totals.length ? totals[Math.min(totals.length - 1, Math.floor(totals.length * q))] : 0);
        const cuts = [quartile(0.25), quartile(0.5), quartile(0.75)];

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // Wind back to the most recent Sunday so every column is a full week.
        const end = new Date(today);
        end.setDate(end.getDate() + (6 - end.getDay()));
        const weeks = [];
        for (let w = 25; w >= 0; w -= 1) {
          const column = [];
          for (let d = 0; d < 7; d += 1) {
            const date = new Date(end);
            date.setDate(end.getDate() - (w * 7) - (6 - d));
            const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            const row = byDay.get(key);
            const total = row ? tokenTotal(row) : 0;
            let level = 0;
            if (total > 0) level = total > cuts[2] ? 4 : total > cuts[1] ? 3 : total > cuts[0] ? 2 : 1;
            column.push({ key, total, level, future: date > today });
          }
          weeks.push(column);
        }
        return weeks;
      }, [days]);

      // Month labels sit above the first week column that begins each month,
      // spaced by how many weeks that month spans — the same construction
      // GitHub uses, and the reason the row lines up with the grid below.
      const months = useMemo(() => {
        const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const out = [];
        let last = -1;
        grid.forEach((week, index) => {
          const first = week[0];
          if (!first) return;
          const month = new Date(first.key + "T00:00:00").getMonth();
          if (month === last) { if (out.length) out[out.length - 1].weeks += 1; return; }
          last = month;
          out.push({ label: MONTH[month], weeks: 1, index });
        });
        return out;
      }, [grid]);

      return h("div", null,
        h("div", { className: "dshd-us-cal" },
          h("div", { className: "dshd-us-days" },
            ["", "Mon", "", "Wed", "", "Fri", ""].map((label, i) =>
              h("span", { key: i }, label))),
          h("div", { className: "dshd-us-cal-scroll", role: "region", tabIndex: 0, "aria-label": "26-week activity heatmap. Scroll horizontally on smaller screens." },
            h("div", { className: "dshd-us-months" },
              months.map((m) =>
                h("span", { key: m.index, style: { gridColumn: `span ${m.weeks}` } }, m.label))),
            h("div", { className: "dshd-us-heat" },
              grid.map((week, i) => h("div", { key: i, className: "dshd-us-week" },
                week.map((cell) => h("div", {
                  key: cell.key,
                  className: "dshd-us-cell",
                  "data-level": String(cell.level),
                  style: cell.future ? { visibility: "hidden" } : undefined,
                  title: cell.total > 0
                    ? `${cell.key} · ${compact(cell.total)} tokens`
                    : `${cell.key} · nothing`,
                }))))))),
        h("div", { className: "dshd-us-legend" },
          h("span", null, "Less"),
          [0, 1, 2, 3, 4].map((level) =>
            h("i", { key: level, className: "dshd-us-cell", "data-level": String(level),
              style: { width: "14px", height: "14px" } })),
          h("span", null, "More")));
    }

    function UsageSection() {
      ensureStyle();
      const [data, setData] = useState(null);
      const [modelQuery, setModelQuery] = useState("");
      const [copied, setCopied] = useState("");
      const [updatedAt, setUpdatedAt] = useState(null);
      const [failed, setFailed] = useState(false);
      const [loading, setLoading] = useState(false);
      const request = useRef(null);

      const load = useCallback(() => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setFailed(false); setLoading(true);
        fetch(ENDPOINT, { credentials: "same-origin", signal: controller.signal })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((result) => {
            if (controller.signal.aborted) return;
            if (!validSummary(result)) throw new Error("Invalid usage summary");
            setData(result); setUpdatedAt(Date.now());
          })
          .catch(() => { if (!controller.signal.aborted) setFailed(true); })
          .finally(() => { if (!controller.signal.aborted) setLoading(false); });
      }, []);
      useEffect(() => { load(); return () => request.current?.abort(); }, [load]);
      const heading = h("div", { className: "dshd-us-head" },
        h("h2", null, "Usage"),
        h("button", { type: "button", className: "dshd-us-refresh", disabled: loading, onClick: load },
          loading ? "Refreshing…" : failed ? "Retry" : "Refresh"));
      const notice = failed ? h("div", { className: "dshd-us-empty", role: "alert" },
        data ? "Refresh failed. Showing the last successful read; retry to update usage." : "Usage could not be read right now. Retry to load your session history.") : null;
      const coverage = data?.coverage;
      const issueLabels = { oversized: "size limit reached", unreadable: "unreadable logs", corrupt: "invalid log data",
        truncated: "incomplete writes", ambiguous: "conflicting log formats", invalidUsage: "invalid usage samples" };
      const coverageNotice = coverage && !coverage.complete ? h("div", { className: "dshd-us-coverage", role: "status" },
        h("b", null, "Partial session history"),
        h("p", null, `${coverage.read} complete logs · ${coverage.partial} partial · ${coverage.skipped} skipped`
          + (coverage.unavailable ? ` · ${coverage.unavailable} unavailable folders` : "")),
        h("p", null, Object.entries(issueLabels).filter(([key]) => coverage.issues[key] > 0)
          .map(([key, label]) => `${label}: ${coverage.issues[key]}`).join(" · ")),
        h("p", null, "Totals include only confirmed usage. Refresh after an active write finishes or the history becomes available.")) : null;

      if (failed && !data) {
        return h("div", { className: "dshd-us" },
          heading, h(AccountUsage), notice);
      }
      if (!data) {
        return h("div", { className: "dshd-us" },
          heading, h(AccountUsage),
          h("div", { className: "dshd-us-empty", role: "status" }, "Reading your session history…"));
      }

      const totals = data.totals;
      const models = data.models || [];
      const hasAny = Boolean(totals && totals.turns > 0);

      if (!hasAny) {
        return h("div", { className: "dshd-us" },
          heading, h(AccountUsage), notice, coverageNotice,
          h("p", { className: "intro" },
            "Recorded token usage from this app's readable session logs."),
          h("div", { className: "dshd-us-empty" },
            coverage && !coverage.complete ? "No confirmed usage could be read from this incomplete history."
              : "No usage reported yet"));
      }

      const grand = tokenTotal(totals);

      const when = (ms) => new Date(ms).toLocaleDateString(undefined,
        { day: "numeric", month: "short", year: "numeric" });
      const hours = data.hours || [];
      const peak = hours.length
        ? hours.reduce((best, value, hour) => (value > hours[best] ? hour : best), 0)
        : null;
      const hourLabel = (hour) => {
        const suffix = hour < 12 ? "am" : "pm";
        const twelve = hour % 12 === 0 ? 12 : hour % 12;
        return `${twelve}${suffix}`;
      };
      const rangeLabel = totals.firstAt != null
        ? `${when(totals.firstAt)} — ${when(totals.lastAt)}`
          + (peak !== null && hours[peak] > 0
            ? ` · busiest around ${hourLabel(peak)}`
            : "")
        : null;

      const inputTotal = totals.input + (totals.cacheRead || 0) + (totals.cacheWrite || 0);
      const cacheRate = inputTotal ? (totals.cacheRead || 0) / inputTotal : null;
      const providers = new Map();
      for (const model of models) {
        const value = providers.get(model.provider) || {provider:model.provider,input:0,output:0,cacheRead:0,cacheWrite:0,turns:0};
        for (const key of ['input','output','cacheRead','cacheWrite','turns']) value[key] += model[key] || 0;
        providers.set(model.provider,value);
      }
      const exact = n => n.toLocaleString();
      const tile = (label, value, full, tone) => h('div', {className:'dshd-us-tile',key:label,title:full,'data-tone':tone},h('b',null,value),h('span',null,label));
      const table = (rows, first, identify) => h('div',{className:'dshd-us-table-scroll',tabIndex:0,'aria-label':first+' usage details'},
        h('table',null,h('thead',null,h('tr',null,[first,'Calls','Input','Output','Cache read','Cache write','Total'].map(label=>h('th',{key:label,scope:'col'},label)))),
          h('tbody',null,rows.map(row=>h('tr',{key:identify(row)},h('td',null,row.provider ? h('span',{'data-dshd-provider':row.provider},identify(row)) : identify(row)),...['turns','input','output','cacheRead','cacheWrite'].map(key=>h('td',{key},exact(row[key]||0))),h('td',null,exact(tokenTotal(row))))))));
      const filtered = models.filter(m => `${PROVIDER[m.provider] || m.provider} ${m.model}`.toLocaleLowerCase().includes(modelQuery.toLocaleLowerCase()));
      return h('div',{className:'dshd-us','aria-busy':loading},heading,h(AccountUsage),notice,coverageNotice,
        h('div',{className:'dshd-us-hero'},h('div',null,h('small',null,'Your workspace, by the numbers'),h('strong',null,compact(grand)+' tokens'),h('p',{className:'intro'},rangeLabel)),
          h('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.2,'aria-hidden':true},h('path',{d:'M3 20h18M6 16v-5m6 5V4m6 12V8'}))),
        h('p',{className:'intro'},`Recorded usage across ${totals.sessions} ${totals.sessions===1?'session':'sessions'} on this computer. Calls without reported usage are not included. Hover over a value for its exact count.`),
        h('div',{className:'dshd-us-tiles'},
          tile('Tokens total',compact(grand),exact(grand)+' tokens'),
          tile(totals.turns===1?'Reported call':'Reported calls',exact(totals.turns)),
          tile('Cache reuse',cacheRate===null?'—':(cacheRate*100).toFixed(1)+'%','Cache reads / all input tokens',cacheRate>=.75?'good':undefined),
          tile('Uncached input',compact(totals.input),exact(totals.input)+' tokens'),
          tile('Output tokens',compact(totals.output),exact(totals.output)+' tokens'),
          tile('Cache reads',compact(totals.cacheRead||0),exact(totals.cacheRead||0)+' tokens','good'),
          tile('Cache writes',compact(totals.cacheWrite||0),exact(totals.cacheWrite||0)+' tokens'),
          tile('Tokens / call',compact(Math.round(grand/totals.turns)),exact(Math.round(grand/totals.turns))+' average'),
          tile('Active days',data.days.filter(day=>day.turns>0).length),
          tile('Sessions',totals.sessions),tile('Models',models.length),tile('Providers',providers.size)),
        h('section',{className:'dshd-us-section'},h('div',{className:'dshd-us-section-head'},h('h2',null,'Activity'),h('span',{className:'dshd-us-caption'},'Last 26 weeks · local time')),h(HeatMap,{days:data.days}),
          h('div',{className:'dshd-us-section-head',style:{marginTop:24,marginBottom:0}},h('h2',null,'By hour'),h('span',{className:'dshd-us-caption'},'All recorded dates · tokens')),
          h('div',{className:'dshd-us-hourly','aria-label':'Token usage by hour'},hours.map((value,hour)=>h('div',{key:hour,tabIndex:0,title:`${hourLabel(hour)} · ${exact(value)} tokens`,'aria-label':`${hourLabel(hour)}: ${exact(value)} tokens`},h('i',{style:{height:`${value/Math.max(1,...hours)*100}%`,opacity:value?1:.15}})))),
          h('div',{className:'dshd-us-hour-axis'},['12am','6am','12pm','6pm','11pm'].map(label=>h('span',{key:label},label)))),
        h('section',{className:'dshd-us-section'},h('div',{className:'dshd-us-section-head'},h('h2',null,'By model'),h('input',{type:'search','aria-label':'Filter models',placeholder:'Find model or provider…',value:modelQuery,onChange:e=>setModelQuery(e.target.value)})),
          h('div',{className:'dshd-us-rows'},filtered.map(m=>{
            const total=tokenTotal(m),pct=n=>total?n/total*100:0;
            return h('div',{key:JSON.stringify([m.provider,m.model]),className:'dshd-us-row'},
              h('div',{className:'dshd-us-rowhead'},h('b',{'data-dshd-model':m.model,'data-dshd-provider':m.provider},m.model),h('span',{className:'prov','data-dshd-provider':m.provider},PROVIDER[m.provider]||m.provider),h('span',{className:'tot',title:exact(total)+' tokens'},`${compact(total)} · ${(grand?total/grand*100:0).toFixed(1)}%`)),
              h('div',{className:'dshd-us-split'},[['in',m.input],['out',m.output],['read',m.cacheRead||0],['write',m.cacheWrite||0]].map(([key,value])=>h('i',{key,className:key,style:{width:pct(value)+'%'}}))),
              h('div',{className:'dshd-us-sub'},[['input',m.input,'uncached input'],['output',m.output,'output'],['cache',m.cacheRead||0,'cache read'],['write',m.cacheWrite||0,'cache written']].map(([key,value,label])=>h('span',{key,className:'dshd-us-key',title:exact(value)+' '+label+' tokens'},h('i',{style:{background:`var(--usage-${key})`}}),`${compact(value)} ${label}`)),h('span',null,`${m.turns} ${m.turns===1?'call':'calls'}`),h('span',null,`${compact(Math.round(total/Math.max(1,m.turns)))} tokens/call`)));
          })),filtered.length?null:h('p',{className:'intro'},'No models match your filter.')),
        h('section',{className:'dshd-us-section'},h('h2',null,'By provider'),table([...providers.values()].sort((a,b)=>tokenTotal(b)-tokenTotal(a)),'Provider',r=>PROVIDER[r.provider]||r.provider)),
        h('section',{className:'dshd-us-section'},h('h2',null,'Daily history'),h('p',{className:'intro'},'Every recorded day, newest first. Counts below are exact.'),table([...data.days].reverse(),'Date',r=>r.day)),
        h('details',{className:'dshd-us-section'},h('summary',null,'Data coverage and definitions'),
          h('p',{className:'intro'},coverage?`${coverage.read} complete logs · ${coverage.partial} partial · ${coverage.skipped} skipped · ${coverage.unavailable} unavailable folders`:'Coverage details are unavailable from this host.'),
          h('p',{className:'intro'},'Input means uncached input; cache reads and writes are separate buckets. Total includes all four token buckets. Usage is measured from local session logs, not subscription limits or billing. Cost and remaining quota are not reported here.'),
          h('p',{className:'intro'},`First activity: ${totals.firstAt==null?'Unknown':new Date(totals.firstAt).toLocaleString()}. Latest activity: ${totals.lastAt==null?'Unknown':new Date(totals.lastAt).toLocaleString()}.`)),
        h('div',{className:'dshd-us-head'},h('span',null,updatedAt?'Updated '+new Date(updatedAt).toLocaleTimeString():''),h('button',{type:'button',className:'dshd-us-refresh',onClick:async()=>{try{await navigator.clipboard.writeText(JSON.stringify(data,null,2));setCopied('Report copied.');}catch{setCopied('Could not copy. Clipboard access is unavailable.');}}},'Copy full report')),
        copied?h('p',{className:'intro',role:'status'},copied):null);
    }

    /** Required service: the UI slot registry. */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "usage", order: 2, label: () => "Usage" },
          UsageSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
