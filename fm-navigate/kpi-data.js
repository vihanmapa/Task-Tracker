/* ============================================================
   FM Navigate — KPI catalog (static definitions)
   ------------------------------------------------------------
   The 22 KPIs management self-scores 0–5 each month, in 5
   categories (A–E). Derived from docs/KPI-PLAN.md §3 and the
   "FM Navigate – Monthly KPI Self-Scoring Scorecard" workbook.

   Ships as a constant (not user data). User data = per-KPI,
   per-month scores, held in the `kpiScores` backend collection.

   Exposes:
     window.KPI_DEFS        [{ code, category, name, target, type, source }]
     window.KPI_CATEGORIES  { A: {name, ...}, ... }  (ordered A→E)
     window.KPI_SCORE_BANDS  0–5 → { label, tone }   (workbook score guide)
     window.kpiMonthKey(date) -> 'YYYY-MM'
     window.kpiMonthLabel(key) -> 'Jun 2026'
     window.kpiScoreBand(score) -> band | null
   ============================================================ */
(function () {
  // Score guide — exactly the workbook's row-3 legend.
  var BANDS = {
    0: { label: 'No progress',          tone: 'red'    },
    1: { label: 'Significant slippage', tone: 'red'    },
    2: { label: 'Below expectations',   tone: 'orange' },
    3: { label: 'Meets expectations',   tone: 'yellow' },
    4: { label: 'Exceeds expectations', tone: 'green'  },
    5: { label: 'Outstanding',          tone: 'green'  },
  };

  var CATEGORIES = {
    A: { code: 'A', name: 'Delivery & Technical Team Management', short: 'Delivery & Technical' },
    B: { code: 'B', name: 'Communication & Reporting',           short: 'Communication' },
    C: { code: 'C', name: 'Marketing, Pre-Sales & Sales',        short: 'Marketing & Sales' },
    D: { code: 'D', name: 'Operational Readiness & Compliance',  short: 'Operations' },
    E: { code: 'E', name: 'Continuous Improvement & Coordination', short: 'Continuous Improvement' },
  };

  // type: 'auto' = a future log can suggest the score · 'manual' = PM scores by hand.
  // source is the collection a later auto-score engine would read (informational now).
  var DEFS = [
    // A — Delivery & Technical (5)
    { code: 'A1', category: 'A', name: 'Sprint Delivery Rate',        target: '≥ 90% of sprint tasks completed on time',          type: 'auto',   source: 'sprints' },
    { code: 'A2', category: 'A', name: 'Developer Accountability',    target: 'Weekly attendance logs; bi-weekly in-office',      type: 'auto',   source: 'attendance' },
    { code: 'A3', category: 'A', name: 'Development Plan Accuracy',   target: 'No more than 10% deviation from plan',             type: 'auto',   source: 'sprints' },
    { code: 'A4', category: 'A', name: 'Issue Resolution',           target: 'All critical issues resolved within SLA',          type: 'auto',   source: 'issues' },
    { code: 'A5', category: 'A', name: 'Team Performance Reporting',  target: 'Weekly dashboard submitted',                       type: 'manual', source: null },
    // B — Communication & Reporting (4)
    { code: 'B1', category: 'B', name: 'Weekly Monday Report',        target: '100% delivered on time',                           type: 'manual', source: null },
    { code: 'B2', category: 'B', name: 'Friday Progress Summary',     target: '100% delivered on time',                           type: 'manual', source: null },
    { code: 'B3', category: 'B', name: 'Transparency Dashboard',      target: 'Updated weekly; single source of truth',           type: 'manual', source: null },
    { code: 'B4', category: 'B', name: 'Risk Reporting',             target: 'All risks logged with documented mitigation',      type: 'auto',   source: 'risks' },
    // C — Marketing, Pre-Sales & Sales (6)
    { code: 'C1', category: 'C', name: 'New Clients Acquired',        target: '3 in first 3 months; 5 within 6 months',           type: 'manual', source: null },
    { code: 'C2', category: 'C', name: 'Demos Delivered',            target: '≥ 3 per week',                                     type: 'auto',   source: 'demos' },
    { code: 'C3', category: 'C', name: 'Marketing Content Produced',  target: '4 pieces per month',                               type: 'auto',   source: 'marketing' },
    { code: 'C4', category: 'C', name: 'Lead Generation',           target: '≥ 20 new leads per month',                         type: 'auto',   source: 'marketing' },
    { code: 'C5', category: 'C', name: 'Reseller Pipeline',          target: '3 active resellers by month 3',                    type: 'manual', source: null },
    { code: 'C6', category: 'C', name: 'Event Participation',        target: '1 local event per month',                          type: 'auto',   source: 'marketing' },
    // D — Operational Readiness & Compliance (3)
    { code: 'D1', category: 'D', name: 'ISO 27001 Documentation',    target: '100% drafted by Month 4',                          type: 'manual', source: null },
    { code: 'D2', category: 'D', name: 'Cyber Essentials+ Maintenance', target: 'Updated quarterly',                             type: 'manual', source: null },
    { code: 'D3', category: 'D', name: 'Legal Documents',           target: 'All agreements finalised',                         type: 'manual', source: null },
    // E — Continuous Improvement & Coordination (4)
    { code: 'E1', category: 'E', name: 'AI Improvements',           target: 'Delivered as agreed',                              type: 'manual', source: null },
    { code: 'E2', category: 'E', name: 'Process Improvements',       target: '1 per month',                                      type: 'manual', source: null },
    { code: 'E3', category: 'E', name: 'Cross-Team Coordination',    target: 'Weekly alignment',                                 type: 'manual', source: null },
    { code: 'E4', category: 'E', name: 'Customer Satisfaction',      target: 'Positive demo/client feedback',                    type: 'manual', source: null },
  ];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function monthKey(date) {
    var d = date ? new Date(date) : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthLabel(key) {
    if (!key) return '';
    var p = key.split('-');
    return MONTHS[(parseInt(p[1], 10) || 1) - 1] + ' ' + p[0];
  }
  function scoreBand(score) {
    if (score == null || score === '') return null;
    var n = Math.round(Number(score));
    return BANDS[n] || null;
  }

  window.KPI_DEFS = DEFS;
  window.KPI_CATEGORIES = CATEGORIES;
  window.KPI_CATEGORY_ORDER = ['A', 'B', 'C', 'D', 'E'];
  window.KPI_SCORE_BANDS = BANDS;
  window.kpiMonthKey = monthKey;
  window.kpiMonthLabel = monthLabel;
  window.kpiScoreBand = scoreBand;
})();
