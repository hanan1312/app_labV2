import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../lib/apiFetch';
import { useTranslations } from '../../lib/i18n';

interface TransactionRow {
  date: string;
  final_payment: number;
  tests: string[];
}

interface ClientRow {
  gender?: string | null;
}

// Port of script_lab.js's cairoDateStr() — "YYYY-MM-DD" for a given instant as it reads in
// Africa/Cairo local time, matching the server-stamped date strings on every transaction
// regardless of the viewing browser's own OS timezone. Kept as its own local copy rather than
// a globals.d.ts bridge (pure, stateless, trivial) — same call DashboardTab.tsx already made
// for isDateInRange().
function cairoDateStr(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(date);
}

// Reads the app's own theme tokens so the chart matches dark/light mode automatically — same
// ref/destroy-before-create pattern as DashboardTab's DemandChart / AttendanceDrillDownModal's
// TrendChart. Unlike those two, the vanilla renderFinancialCharts() this ports used hardcoded
// hex colors (not theme CSS variables) for its own three charts — preserved as-is here for
// pixel parity rather than "fixed" into theme-awareness, since that's not what the original did.
function RevenueLineChart({ data }: { data: [string, number][] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window.Chart === 'undefined') return;
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    chartRef.current = new window.Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map((d) => d[0]),
        datasets: [
          {
            label: 'Daily Revenue (EGP)',
            data: data.map((d) => d[1]),
            borderColor: '#5cbdb9',
            backgroundColor: 'rgba(92, 189, 185, 0.2)',
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            pointBackgroundColor: '#04121d',
            pointBorderColor: '#5cbdb9',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
          x: { grid: { display: false } },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data]);

  return <canvas ref={canvasRef} />;
}

function GenderDoughnutChart({ male, female }: { male: number; female: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window.Chart === 'undefined') return;
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    chartRef.current = new window.Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Male', 'Female'],
        datasets: [
          {
            data: [male, female],
            backgroundColor: ['#3b82f6', '#ef6b6b'],
            borderWidth: 0,
            hoverOffset: 10,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
        plugins: {
          legend: { position: 'bottom' },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [male, female]);

  return <canvas ref={canvasRef} />;
}

function TestDemandBarChart({ data }: { data: [string, number][] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window.Chart === 'undefined') return;
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    chartRef.current = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map((d) => d[0]),
        datasets: [
          {
            label: 'Times Demanded',
            data: data.map((d) => d[1]),
            backgroundColor: 'rgba(232, 192, 122, 0.8)',
            borderColor: '#e8c07a',
            borderWidth: 1,
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
          x: { grid: { display: false } },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data]);

  return <canvas ref={canvasRef} />;
}

export default function FinancialOverviewTab() {
  const { t } = useTranslations();
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch('/api/transactions').then((res) => (res.ok ? (res.json() as Promise<TransactionRow[]>) : [])),
      apiFetch('/api/clients').then((res) => (res.ok ? (res.json() as Promise<ClientRow[]>) : [])),
    ])
      .then(([txns, cls]) => {
        if (cancelled) return;
        setTransactions(txns);
        setClients(cls);
      })
      .catch((err) => console.error('Failed to load financial data:', err));
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Same self-attached nav-tab click / lab:refresh-financial-overview CustomEvent bridge as
  // every other migrated tab — the latter is dispatched both from refreshVisibleTables() and
  // from fetchTransactionsData() directly (the vanilla function that still keeps
  // `allTransactions` fresh for the checkout modal's payment-method <datalist>), so a
  // transaction mutated elsewhere (e.g. Transaction History's Complete Payment/bulk delete)
  // updates these totals too.
  useEffect(() => {
    const tabButton = document.querySelector('.nav-tab[data-tab="financial-overview"]');
    const onRefresh = () => setRefreshTick((n) => n + 1);
    tabButton?.addEventListener('click', onRefresh);
    window.addEventListener('lab:refresh-financial-overview', onRefresh);
    return () => {
      tabButton?.removeEventListener('click', onRefresh);
      window.removeEventListener('lab:refresh-financial-overview', onRefresh);
    };
  }, []);

  const stats = useMemo(() => {
    const todayStr = cairoDateStr();
    const monthStr = todayStr.substring(0, 7);
    const yearStr = todayStr.substring(0, 4);

    let dailyRev = 0;
    let monthlyRev = 0;
    let yearlyRev = 0;

    const revenueByDate: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      revenueByDate[cairoDateStr(d)] = 0;
    }

    transactions.forEach((txn) => {
      const payment = parseFloat(String(txn.final_payment));
      const tDateStr = txn.date.split(' ')[0];

      if (txn.date.startsWith(todayStr)) dailyRev += payment;
      if (txn.date.startsWith(monthStr)) monthlyRev += payment;
      if (txn.date.startsWith(yearStr)) yearlyRev += payment;

      if (revenueByDate[tDateStr] !== undefined) {
        revenueByDate[tDateStr] += payment;
      }
    });

    let males = 0;
    let females = 0;
    clients.forEach((c) => {
      const gen = c.gender ? c.gender.toLowerCase() : '';
      if (gen === 'male') males++;
      else if (gen === 'female') females++;
    });

    const testCounts: Record<string, number> = {};
    transactions.forEach((txn) => {
      if (txn.tests && Array.isArray(txn.tests)) {
        txn.tests.forEach((test) => {
          testCounts[test] = (testCounts[test] || 0) + 1;
        });
      }
    });
    const sortedTests = Object.entries(testCounts).sort((a, b) => b[1] - a[1]).slice(0, 10) as [string, number][];

    return { dailyRev, monthlyRev, yearlyRev, revenueByDate, males, females, sortedTests, todayStr };
  }, [transactions, clients]);

  // Revenue-milestone toast, throttled once/day via localStorage — same condition and key as
  // the vanilla calculateFinancials() (today's revenue-so-far beats yesterday's full-day total).
  useEffect(() => {
    if (transactions.length === 0) return;
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterdayStr = cairoDateStr(d);
    const yesterdayRev = stats.revenueByDate[yesterdayStr] || 0;
    if (stats.dailyRev > yesterdayRev && yesterdayRev > 0) {
      const lastNotifDate = localStorage.getItem('last_rev_notif_date');
      if (lastNotifDate !== stats.todayStr) {
        window.addNotification(
          t('alerts.revenue_milestone', "Great job! Today's revenue ({today} EGP) surpassed yesterday's ({yesterday} EGP).", {
            today: stats.dailyRev.toFixed(2),
            yesterday: yesterdayRev.toFixed(2),
          }),
          'success'
        );
        localStorage.setItem('last_rev_notif_date', stats.todayStr);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.dailyRev, stats.todayStr]);

  const revenueChartData = Object.entries(stats.revenueByDate) as [string, number][];

  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <h1>{t('financials.title', 'Financial Statistics')}</h1>
        <p style={{ color: 'var(--muted)' }}>{t('financials.subtitle', 'Real-time revenue tracking and statistics')}</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 30 }}>
        <div className="glass-panel" style={{ padding: 25, textAlign: 'center', borderRadius: 12 }}>
          <h3 style={{ color: 'var(--muted)', marginBottom: 10, fontSize: 14, textTransform: 'uppercase', letterSpacing: 1 }}>
            {t('financials.daily_revenue', 'Daily Revenue')}
          </h3>
          <div style={{ fontSize: 36, fontWeight: 'bold', color: 'var(--ok)' }}>{stats.dailyRev.toFixed(2)} EGP</div>
        </div>
        <div className="glass-panel" style={{ padding: 25, textAlign: 'center', borderRadius: 12 }}>
          <h3 style={{ color: 'var(--muted)', marginBottom: 10, fontSize: 14, textTransform: 'uppercase', letterSpacing: 1 }}>
            {t('financials.monthly_revenue', 'Monthly Revenue')}
          </h3>
          <div style={{ fontSize: 36, fontWeight: 'bold', color: 'var(--teal)' }}>{stats.monthlyRev.toFixed(2)} EGP</div>
        </div>
        <div className="glass-panel" style={{ padding: 25, textAlign: 'center', borderRadius: 12 }}>
          <h3 style={{ color: 'var(--muted)', marginBottom: 10, fontSize: 14, textTransform: 'uppercase', letterSpacing: 1 }}>
            {t('financials.yearly_revenue', 'Yearly Revenue')}
          </h3>
          <div style={{ fontSize: 36, fontWeight: 'bold', color: '#3b82f6' }}>{stats.yearlyRev.toFixed(2)} EGP</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, marginBottom: 20 }}>
        <div className="glass-panel" style={{ padding: 20, borderRadius: 12, height: 350 }}>
          <h3 style={{ marginBottom: 15, color: 'var(--text)' }}>{t('financials.revenue_trend', 'Revenue Trend (Last 7 Days)')}</h3>
          <div style={{ position: 'relative', height: 280, width: '100%' }}>
            <RevenueLineChart data={revenueChartData} />
          </div>
        </div>
        <div className="glass-panel" style={{ padding: 20, borderRadius: 12, height: 350 }}>
          <h3 style={{ marginBottom: 15, color: 'var(--text)' }}>{t('financials.demographics', 'Patient Demographics')}</h3>
          <div style={{ position: 'relative', height: 280, width: '100%' }}>
            <GenderDoughnutChart male={stats.males} female={stats.females} />
          </div>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 20, borderRadius: 12 }}>
        <h3 style={{ marginBottom: 15, color: 'var(--text)' }}>{t('financials.top_tests', 'Top Demanded Tests')}</h3>
        <div style={{ position: 'relative', height: 300, width: '100%' }}>
          <TestDemandBarChart data={stats.sortedTests} />
        </div>
      </div>
    </>
  );
}
