import { useEffect, useState } from 'react';
import { api, type SchedulerJobState, type SchedulerJobStatus } from '../lib/api';
import { Button, PageHeader, Panel, StatusPill } from '../components/ui';

function statusTone(status: SchedulerJobStatus | null): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (status === 'succeeded') return 'success';
  if (status === 'running') return 'info';
  if (status === 'failed') return 'danger';
  if (status === 'skipped') return 'warning';
  return 'neutral';
}

function formatTime(value: number | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDuration(value: number | null): string {
  if (value === null) return 'n/a';
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(1)}s`;
}

export function SchedulerPage() {
  const [jobs, setJobs] = useState<SchedulerJobState[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const result = await api.schedulerJobs();
    setJobs(result.jobs);
  };

  useEffect(() => {
    refresh()
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const runNow = async (jobName: string) => {
    setRunning(jobName);
    setError(null);
    try {
      await api.runSchedulerJob(jobName);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div>
      <PageHeader
        domain="Operations"
        title="Scheduler"
        description="Cron job state, last run outcome, next expected run, and manual triggers."
        actions={<Button variant="secondary" onClick={() => void refresh()}>Refresh</Button>}
      />

      {error && (
        <Panel className="mb-4 border-[color:var(--sd-danger)] p-3 text-sm text-[color:var(--sd-danger)]">
          {error}
        </Panel>
      )}

      <Panel className="overflow-hidden">
        {loading ? (
          <div className="p-4 text-sm text-[color:var(--sd-muted)]">Loading...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[color:var(--sd-border)] text-xs uppercase tracking-wide text-[color:var(--sd-subtle)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Job</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Schedule</th>
                  <th className="px-4 py-3 font-medium">Last Run</th>
                  <th className="px-4 py-3 font-medium">Next</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.jobName} className="border-b border-[color:var(--sd-border)] last:border-b-0">
                    <td className="px-4 py-3 align-top">
                      <div className="font-medium text-[color:var(--sd-text)]">{job.jobName}</div>
                      <div className="mt-1 text-xs text-[color:var(--sd-muted)]">
                        {job.type} · {job.targetPlatform ?? 'system'}:{job.targetChannel ?? 'internal'}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <StatusPill tone={statusTone(job.lastStatus)}>{job.lastStatus ?? 'registered'}</StatusPill>
                      {job.lastError && (
                        <div className="mt-2 max-w-xs break-words text-xs text-[color:var(--sd-muted)]">{job.lastError}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-[color:var(--sd-muted)]">
                      <div>{job.cron}</div>
                      <div className="mt-1 text-xs">{job.timezone}</div>
                    </td>
                    <td className="px-4 py-3 align-top text-[color:var(--sd-muted)]">
                      <div>{formatTime(job.lastCompletedAt ?? job.lastStartedAt)}</div>
                      <div className="mt-1 text-xs">{formatDuration(job.lastDurationMs)}</div>
                    </td>
                    <td className="px-4 py-3 align-top text-[color:var(--sd-muted)]">{formatTime(job.nextExpectedAt)}</td>
                    <td className="px-4 py-3 align-top">
                      <Button
                        variant="secondary"
                        className="px-3 py-1.5 text-xs"
                        disabled={!job.enabled || running === job.jobName}
                        onClick={() => void runNow(job.jobName)}
                      >
                        {running === job.jobName ? 'Running' : 'Run Now'}
                      </Button>
                    </td>
                  </tr>
                ))}
                {jobs.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-sm text-[color:var(--sd-muted)]" colSpan={6}>
                      No scheduler jobs have registered yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
