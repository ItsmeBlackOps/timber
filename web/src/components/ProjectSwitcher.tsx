import type { Project } from '@/lib/types'

export interface ProjectSwitcherProps {
  projects: Project[];
  value: string | undefined;
  onChange: (slug: string | undefined) => void;
  onManage: () => void;
}

const ALL = '__all__';

export function ProjectSwitcher({ projects, value, onChange, onManage }: ProjectSwitcherProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <select
        aria-label="Project"
        value={value ?? ALL}
        onChange={(e) => { const v = e.target.value; onChange(v === ALL ? undefined : v); }}
        style={{ height: 32, padding: '0 8px', borderRadius: 6, border: '1px solid var(--tb-border)', background: 'var(--tb-surface)', color: 'var(--tb-text)', fontSize: 13, cursor: 'pointer' }}
      >
        <option value={ALL}>All projects</option>
        {projects.map((p) => (<option key={p.slug} value={p.slug}>{p.name}</option>))}
      </select>
      <button
        type="button"
        aria-label="Manage projects"
        title="Manage projects"
        onClick={onManage}
        style={{ height: 32, padding: '0 8px', borderRadius: 6, border: '1px solid var(--tb-border)', background: 'var(--tb-surface)', color: 'var(--tb-text)', fontSize: 13, cursor: 'pointer' }}
      >
        Manage
      </button>
    </span>
  )
}
