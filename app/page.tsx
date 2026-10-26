'use client'

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  BedDouble,
  Bell,
  Check,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileBarChart,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Stethoscope,
  Users,
  X,
  Zap,
} from 'lucide-react'
import { api, setAccessToken } from '@/lib/api'

type Role = 'admin' | 'physician' | 'nurse' | 'triage'
type Acuity = 'Critical' | 'Urgent' | 'Standard'
type PatientStatus = 'Waiting' | 'In treatment' | 'Reassessment' | 'Discharged'

type User = { id: number; email: string; name: string; role: Role }
type Patient = {
  id: number
  external_id: string
  name: string
  age: number
  reason: string
  acuity: Acuity
  status: PatientStatus
  area: string
  created_at: string
  updated_at: string
}
type Resource = { id: number; name: string; total: number; used: number; status: string }
type Alert = {
  id: number
  kind: string
  title: string
  body: string
  patient_id: number | null
  resolved: boolean
  created_at: string
}
type Observation = {
  id: number
  patient_id: number
  heart_rate: number | null
  respiratory_rate: number | null
  notes: string
  created_at: string
}
type Analytics = {
  patients_in_queue: number
  acuity_mix: Record<Acuity, number>
  status_counts: Record<'Waiting' | 'In treatment' | 'Reassessment', number>
  arrivals: number
  in_treatment: number
  discharged: number
  recorded_at: string
}
type Workspace = {
  patients: Patient[]
  resources: Resource[]
  alerts: Alert[]
  analytics: Analytics
}

const nav = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Patient queue', icon: ClipboardList },
  { label: 'Resources', icon: BedDouble },
  { label: 'Observations', icon: Activity },
  { label: 'Alerts', icon: Bell },
  { label: 'Analytics', icon: FileBarChart },
]

const emptyWorkspace: Workspace = {
  patients: [],
  resources: [],
  alerts: [],
  analytics: {
    patients_in_queue: 0,
    acuity_mix: { Critical: 0, Urgent: 0, Standard: 0 },
    status_counts: { Waiting: 0, 'In treatment': 0, Reassessment: 0 },
    arrivals: 0,
    in_treatment: 0,
    discharged: 0,
    recorded_at: '',
  },
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

function fullName(user: User) {
  return user.name || user.email
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function timeLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString()
}

function waitMinutes(patient: Patient) {
  const created = new Date(patient.created_at).getTime()
  return Number.isNaN(created)
    ? 0
    : Math.max(0, Math.floor((Date.now() - created) / 60_000))
}

export default function Page() {
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [active, setActive] = useState('Overview')
  const [query, setQuery] = useState('')
  const [acuityFilter, setAcuityFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [showRegister, setShowRegister] = useState(false)
  const [showMobileNav, setShowMobileNav] = useState(false)
  const [toast, setToast] = useState('')

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 3200)
  }, [])

  const loadWorkspace = useCallback(async () => {
    setWorkspaceLoading(true)
    setWorkspaceError('')
    try {
      const [patients, resources, alerts, analytics] = await Promise.all([
        api<Patient[]>('/api/patients'),
        api<Resource[]>('/api/resources'),
        api<Alert[]>('/api/alerts'),
        api<Analytics>('/api/analytics'),
      ])
      setWorkspace({ patients, resources, alerts, analytics })
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setWorkspaceLoading(false)
    }
  }, [])

  useEffect(() => {
    const handleExpiredSession = () => {
      setUser(null)
      setWorkspace(emptyWorkspace)
      setWorkspaceError('Your session expired. Sign in again to continue.')
    }
    window.addEventListener('pulsecare:unauthenticated', handleExpiredSession)
    return () => window.removeEventListener('pulsecare:unauthenticated', handleExpiredSession)
  }, [])

  useEffect(() => {
    const token = window.sessionStorage.getItem('pulsecare_token')
    if (!token) {
      setAuthReady(true)
      return
    }
    api<User>('/api/auth/me')
      .then(setUser)
      .catch((error: unknown) => {
        setAccessToken(null)
        setWorkspaceError(errorMessage(error))
      })
      .finally(() => setAuthReady(true))
  }, [])

  useEffect(() => {
    if (user) void loadWorkspace()
  }, [user, loadWorkspace])

  const filteredPatients = useMemo(
    () =>
      workspace.patients.filter(
        (patient) =>
          (acuityFilter === 'All' || patient.acuity === acuityFilter) &&
          (statusFilter === 'All' || patient.status === statusFilter) &&
          `${patient.name} ${patient.external_id} ${patient.reason}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [workspace.patients, query, acuityFilter, statusFilter],
  )

  const signIn = async (email: string, password: string) => {
    const session = await api<{ access_token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    setAccessToken(session.access_token)
    setUser(session.user)
    setWorkspaceError('')
  }

  const signOut = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch (error) {
      notify(`The local session was cleared, but the server did not confirm sign-out: ${errorMessage(error)}`)
    } finally {
      setAccessToken(null)
      setUser(null)
      setWorkspace(emptyWorkspace)
    }
  }

  const registerPatient = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const name = String(data.get('name') ?? '').trim()
    const reason = String(data.get('reason') ?? '').trim()
    const age = Number(data.get('age'))
    if (!name || !reason || !Number.isInteger(age) || age < 0 || age > 120) {
      notify('Enter a name, presenting concern, and age from 0 to 120.')
      return
    }
    try {
      await api<Patient>('/api/patients', {
        method: 'POST',
        body: JSON.stringify({
          name,
          age,
          reason,
          notes: String(data.get('notes') ?? '').trim(),
        }),
      })
      setShowRegister(false)
      notify('Patient registered. Complete triage review before assigning acuity.')
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  const requestReassessment = async (patient: Patient) => {
    try {
      await api(`/api/patients/${patient.id}/reassessment`, { method: 'POST' })
      notify(`Reassessment requested for ${patient.external_id}.`)
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  const updatePatient = async (
    patient: Patient,
    update: Partial<Pick<Patient, 'acuity' | 'status' | 'area'>>,
  ) => {
    try {
      await api<Patient>(`/api/patients/${patient.id}`, {
        method: 'PATCH',
        body: JSON.stringify(update),
      })
      notify(`${patient.external_id} updated.`)
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  const updateResource = async (resource: Resource, used: number) => {
    if (!Number.isInteger(used) || used < 0 || used > resource.total) {
      notify(`Enter a whole number between 0 and ${resource.total}.`)
      return
    }
    try {
      await api<Resource>(`/api/resources/${resource.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ used }),
      })
      notify(`${resource.name} capacity saved.`)
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  const resolveAlert = async (alert: Alert) => {
    try {
      await api(`/api/alerts/${alert.id}/resolve`, { method: 'POST' })
      notify('Alert marked as reviewed.')
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  if (!authReady) {
    return <main className="loading-screen" aria-live="polite">Restoring your secure session…</main>
  }
  if (!user) {
    return <Login onSignIn={signIn} initialError={workspaceError} />
  }

  const canManageResources = user.role === 'admin' || user.role === 'physician'
  const patientCount = workspace.analytics.patients_in_queue
  const longestWait = workspace.patients.reduce(
    (maximum, patient) => Math.max(maximum, waitMinutes(patient)),
    0,
  )
  const availableResources = workspace.resources.reduce(
    (sum, resource) => sum + Math.max(0, resource.total - resource.used),
    0,
  )
  const totalResources = workspace.resources.reduce((sum, resource) => sum + resource.total, 0)

  return (
    <div className="app-shell">
      <aside className={`sidebar ${showMobileNav ? 'mobile-open' : ''}`}>
        <div className="brand">
          <span className="brand-mark"><HeartPulse /></span>
          <span>Pulse<span>Care</span></span>
        </div>
        <div className="facility"><span className="live-dot" /> Northstar General <ChevronRight /></div>
        <nav aria-label="Main navigation">
          {nav.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.label}
                className={active === item.label ? 'nav-item active' : 'nav-item'}
                onClick={() => {
                  setActive(item.label)
                  setShowMobileNav(false)
                }}
              >
                <Icon />
                <span>{item.label}</span>
                {item.label === 'Alerts' && workspace.alerts.length > 0 && (
                  <b>{workspace.alerts.length}</b>
                )}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="user-mini">
            <div className="avatar">{initials(fullName(user))}</div>
            <div><strong>{fullName(user)}</strong><small>{user.role}</small></div>
            <button onClick={signOut} aria-label="Sign out"><LogOut /></button>
          </div>
        </div>
      </aside>
      {showMobileNav && (
        <button className="scrim" onClick={() => setShowMobileNav(false)} aria-label="Close navigation" />
      )}
      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setShowMobileNav(true)} aria-label="Open navigation">
            <Menu />
          </button>
          <div><p className="eyebrow">Emergency operations</p><h1>{active}</h1></div>
          <div className="top-actions">
            <div className="connection">
              <span className="live-dot" /> {workspaceError ? 'Connection issue' : 'Connected'}
            </div>
            <button className="icon-button" onClick={() => void loadWorkspace()} aria-label="Refresh data">
              <RefreshCw />
            </button>
            <div className="avatar avatar-lg" title={fullName(user)}>{initials(fullName(user))}</div>
          </div>
        </header>
        <div className="content-wrap">
          {workspaceError && (
            <div className="inline-error" role="alert">
              <AlertCircle />
              <span>{workspaceError}</span>
              <button className="outline-btn" onClick={() => void loadWorkspace()}>Retry</button>
            </div>
          )}
          {workspaceLoading && <p className="loading-inline" aria-live="polite">Syncing records…</p>}
          {active === 'Overview' && (
            <Overview
              user={user}
              patients={workspace.patients}
              resources={workspace.resources}
              alerts={workspace.alerts}
              analytics={workspace.analytics}
              longestWait={longestWait}
              availableResources={availableResources}
              totalResources={totalResources}
              onRegister={() => setShowRegister(true)}
              onReassess={requestReassessment}
              onNavigate={setActive}
            />
          )}
          {active === 'Patient queue' && (
            <Queue
              patients={filteredPatients}
              query={query}
              setQuery={setQuery}
              filter={acuityFilter}
              setFilter={setAcuityFilter}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              onRegister={() => setShowRegister(true)}
              onReassess={requestReassessment}
              onUpdate={updatePatient}
            />
          )}
          {active === 'Resources' && (
            <Resources
              resources={workspace.resources}
              canManage={canManageResources}
              onUpdate={updateResource}
            />
          )}
          {active === 'Observations' && (
            <Observations
              patients={workspace.patients.filter((patient) => patient.status !== 'Discharged')}
              onSaved={async () => {
                notify('Observation saved and review alert created.')
                await loadWorkspace()
              }}
              onError={notify}
            />
          )}
          {active === 'Alerts' && (
            <Alerts alerts={workspace.alerts} onResolve={resolveAlert} />
          )}
          {active === 'Analytics' && (
            <AnalyticsView analytics={workspace.analytics} patients={workspace.patients} />
          )}
        </div>
      </main>
      {showRegister && (
        <RegisterModal onClose={() => setShowRegister(false)} onSubmit={registerPatient} />
      )}
      {toast && <div className="toast" role="status"><Check /> {toast}</div>}
    </div>
  )
}

function Login({
  onSignIn,
  initialError,
}: {
  onSignIn: (email: string, password: string) => Promise<void>
  initialError: string
}) {
  const [email, setEmail] = useState('demo@northstar.example')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => setError(initialError), [initialError])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await onSignIn(email.trim(), password)
    } catch (signInError) {
      setError(errorMessage(signInError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-panel">
        <div className="brand brand-dark">
          <span className="brand-mark"><HeartPulse /></span>
          <span>Pulse<span>Care</span></span>
        </div>
        <div className="login-copy">
          <p className="eyebrow">Emergency operations platform</p>
          <h1>Clarity when every<br /><em>second counts.</em></h1>
          <p>Coordinate triage, resources, observations, and staff response from one calm command center.</p>
        </div>
        <div className="login-footer">Northstar General Hospital <span>•</span> MED-PS-011 prototype</div>
      </div>
      <div className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <div className="security-icon"><ShieldCheck /></div>
          <h2>Staff sign in</h2>
          <p>Use your authorized hospital account to continue.</p>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <label>Email address
            <input
              autoComplete="username"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button className="primary-btn full" type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in securely'} <ArrowUpRight />
          </button>
          <div className="demo-note">
            <Zap />
            <div><strong>Local development demo</strong><span>Fictional records only. See the README for local demo credentials.</span></div>
          </div>
          <small className="disclaimer">
            Not clinically validated and not a replacement for qualified medical professionals.
          </small>
        </form>
      </div>
    </main>
  )
}

function Overview({
  user,
  patients,
  resources,
  alerts,
  analytics,
  longestWait,
  availableResources,
  totalResources,
  onRegister,
  onReassess,
  onNavigate,
}: {
  user: User
  patients: Patient[]
  resources: Resource[]
  alerts: Alert[]
  analytics: Analytics
  longestWait: number
  availableResources: number
  totalResources: number
  onRegister: () => void
  onReassess: (patient: Patient) => void
  onNavigate: (page: string) => void
}) {
  const firstName = fullName(user).replace(/^(Dr\.?|Mr\.|Mrs\.|Ms\.)\s+/i, '').split(/\s+/)[0]
  return (
    <>
      <div className="welcome-row">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString(undefined, { dateStyle: 'full' })}</p>
          <h2>Welcome, {firstName}</h2>
          <p className="muted">Current operational picture from saved records.</p>
        </div>
        <button className="primary-btn" onClick={onRegister}><Plus /> Register patient</button>
      </div>
      {alerts.length > 0 && (
        <div className="notice">
          <AlertCircle />
          <div><strong>{alerts.length} item{alerts.length === 1 ? '' : 's'} need staff review</strong>
            <span>Review alerts are advisory and do not change acuity automatically.</span></div>
          <button onClick={() => onNavigate('Alerts')}>Review alerts <ArrowUpRight /></button>
        </div>
      )}
      <div className="metric-grid">
        <Metric icon={Users} label="Patients in queue" value={analytics.patients_in_queue} detail={`${analytics.status_counts.Waiting} waiting · ${analytics.status_counts.Reassessment} reassessment`} tone="red" />
        <Metric icon={Clock3} label="Longest wait" value={`${longestWait} min`} detail="Calculated from arrival time" tone="amber" />
        <Metric icon={BedDouble} label="Available resources" value={`${availableResources} / ${totalResources}`} detail="Capacity records" tone="blue" />
        <Metric icon={Activity} label="Open alerts" value={alerts.length} detail={`${analytics.discharged} discharged records`} tone="purple" />
      </div>
      <div className="section-grid">
        <section className="card queue-card">
          <div className="card-heading">
            <div><p className="eyebrow">Live queue</p><h3>Recent patients</h3></div>
            <button className="text-btn" onClick={() => onNavigate('Patient queue')}>View full queue <ArrowUpRight /></button>
          </div>
          {patients.length === 0 ? <EmptyState message="No patient records yet." /> : (
            <QueueRows patients={patients.slice(0, 5)} onReassess={onReassess} />
          )}
        </section>
        <section className="card capacity-card">
          <div className="card-heading">
            <div><p className="eyebrow">Resource capacity</p><h3>At a glance</h3></div>
            <button className="icon-button" onClick={() => onNavigate('Resources')} aria-label="Manage resources"><RefreshCw /></button>
          </div>
          {resources.slice(0, 4).map((resource) => (
            <Capacity key={resource.id} resource={resource} />
          ))}
          {resources.length === 0 && <EmptyState message="No resource records yet." />}
          <div className="capacity-foot">
            <span><span className="live-dot" /> Synchronized from the API</span>
            <button onClick={() => onNavigate('Resources')}>Manage resources</button>
          </div>
        </section>
      </div>
      <div className="bottom-grid">
        <section className="card">
          <div className="card-heading">
            <div><p className="eyebrow">Queue overview</p><h3>Current acuity mix</h3></div>
            <Stethoscope />
          </div>
          <div className="logic-list">
            {(['Critical', 'Urgent', 'Standard'] as Acuity[]).map((acuity) => (
              <span key={acuity}><i className={`dot ${acuity.toLowerCase()}`} /> {acuity}<b>{analytics.acuity_mix[acuity] ?? 0}</b></span>
            ))}
          </div>
          <p className="card-note">Acuity is assigned by authorized staff. The prototype does not provide clinical recommendations.</p>
        </section>
        <section className="card">
          <div className="card-heading">
            <div><p className="eyebrow">Workflow</p><h3>Quick actions</h3></div>
            <button className="text-btn" onClick={() => onNavigate('Alerts')}>Open alerts <ArrowUpRight /></button>
          </div>
          <div className="activity">
            <span className="activity-icon blue"><ClipboardList /></span>
            <div><strong>{analytics.arrivals} total arrivals</strong><small>{analytics.discharged} marked discharged</small></div>
          </div>
          <div className="activity">
            <span className="activity-icon green"><Bell /></span>
            <div><strong>{alerts.length} unresolved alerts</strong><small>Review prompts remain staff-controlled</small></div>
          </div>
        </section>
      </div>
    </>
  )
}

function Queue({
  patients,
  query,
  setQuery,
  filter,
  setFilter,
  statusFilter,
  setStatusFilter,
  onRegister,
  onReassess,
  onUpdate,
}: {
  patients: Patient[]
  query: string
  setQuery: (value: string) => void
  filter: string
  setFilter: (value: string) => void
  statusFilter: string
  setStatusFilter: (value: string) => void
  onRegister: () => void
  onReassess: (patient: Patient) => void
  onUpdate: (patient: Patient, update: Partial<Pick<Patient, 'acuity' | 'status' | 'area'>>) => void
}) {
  return (
    <>
      <div className="page-heading">
        <div><p className="eyebrow">Operational worklist</p><h2>Patient queue</h2>
          <p className="muted">Search records, update workflow status, or request reassessment.</p></div>
        <button className="primary-btn" onClick={onRegister}><Plus /> Register patient</button>
      </div>
      <section className="card table-card">
        <div className="toolbar">
          <div className="search"><Search />
            <input aria-label="Search patients" placeholder="Search patients or ID" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="filter-group">
            {['All', 'Critical', 'Urgent', 'Standard'].map((value) => (
              <button className={filter === value ? 'selected' : ''} key={value} onClick={() => setFilter(value)}>{value}</button>
            ))}
          </div>
          <select aria-label="Filter by workflow status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            {['All', 'Waiting', 'In treatment', 'Reassessment', 'Discharged'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </div>
        {patients.length === 0 ? <EmptyState message="No patients match this view." /> : (
          <QueueRows patients={patients} onReassess={onReassess} onUpdate={onUpdate} editable />
        )}
      </section>
    </>
  )
}

function QueueRows({
  patients,
  onReassess,
  onUpdate,
  editable = false,
}: {
  patients: Patient[]
  onReassess: (patient: Patient) => void
  onUpdate?: (patient: Patient, update: Partial<Pick<Patient, 'acuity' | 'status' | 'area'>>) => void
  editable?: boolean
}) {
  return (
    <div className="queue-rows">
      {patients.map((patient) => (
        <div className="queue-row" key={patient.id}>
          <span className={`acuity ${patient.acuity.toLowerCase()}`} title={patient.acuity}>
            {patient.acuity === 'Critical' ? '1' : patient.acuity === 'Urgent' ? '2' : '3'}
          </span>
          <div className="patient-info">
            <strong>{patient.name}</strong>
            <span>{patient.external_id} · {patient.age} · {patient.reason}</span>
            <span>Arrived {timeLabel(patient.created_at)} · Updated {timeLabel(patient.updated_at)}</span>
          </div>
          <span className="wait-time"><Clock3 /> {waitMinutes(patient)} min</span>
          {editable && onUpdate ? (
            <>
              <select aria-label={`Acuity for ${patient.name}`} value={patient.acuity}
                onChange={(event) => onUpdate(patient, { acuity: event.target.value as Acuity })}>
                <option>Critical</option><option>Urgent</option><option>Standard</option>
              </select>
              <select aria-label={`Status for ${patient.name}`} value={patient.status}
                onChange={(event) => onUpdate(patient, { status: event.target.value as PatientStatus })}>
                <option>Waiting</option><option>In treatment</option><option>Reassessment</option><option>Discharged</option>
              </select>
              <input aria-label={`Treatment area for ${patient.name}`} defaultValue={patient.area}
                maxLength={80} placeholder="Treatment area"
                onBlur={(event) => {
                  const area = event.target.value.trim()
                  if (area !== patient.area) onUpdate(patient, { area })
                }} />
            </>
          ) : (
            <span className={`status ${patient.status.toLowerCase().replace(' ', '-')}`}>{patient.status}</span>
          )}
          {patient.status !== 'Discharged' && patient.status !== 'Reassessment' && (
            <button className="row-action" onClick={() => onReassess(patient)}>Request review</button>
          )}
        </div>
      ))}
    </div>
  )
}

function Resources({
  resources,
  canManage,
  onUpdate,
}: {
  resources: Resource[]
  canManage: boolean
  onUpdate: (resource: Resource, used: number) => void
}) {
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Capacity coordination</p><h2>Resources</h2>
        <p className="muted">Capacity changes are saved to the API and validated against the total.</p></div></div>
      {resources.length === 0 ? <EmptyState message="No resource records yet. Seed the local demo data to get started." /> : (
        <div className="resource-grid">
          {resources.map((resource) => {
            const available = resource.total - resource.used
            return (
              <section className="card resource-card" key={resource.id}>
                <div className="resource-top"><div className="resource-symbol"><BedDouble /></div>
                  <span className={`status ${resource.status.toLowerCase()}`}>{resource.status}</span></div>
                <h3>{resource.name}</h3>
                <div className="resource-numbers"><strong>{available}</strong><span>available of {resource.total}</span></div>
                <div className="progress"><i className={resource.status === 'Limited' ? 'amber' : 'teal'}
                  style={{ width: `${resource.total ? (resource.used / resource.total) * 100 : 0}%` }} /></div>
                <div className="resource-foot"><span>{resource.used} in use · {Math.round(resource.total ? (resource.used / resource.total) * 100 : 0)}% utilized</span></div>
                {canManage ? (
                  <form className="resource-update" onSubmit={(event) => {
                    event.preventDefault()
                    const value = Number(new FormData(event.currentTarget).get('used'))
                    onUpdate(resource, value)
                  }}>
                    <label>In use
                      <input name="used" type="number" min="0" max={resource.total} defaultValue={resource.used} required />
                    </label>
                    <button className="outline-btn" type="submit">Save</button>
                  </form>
                ) : <p className="card-note">Only physicians and administrators can update capacity.</p>}
              </section>
            )
          })}
        </div>
      )}
      <div className="card safety-callout"><ShieldCheck /><div><strong>Staff-controlled capacity</strong>
        <span>PulseCare does not assign patients to resources. Clinical decisions remain with qualified staff.</span></div></div>
    </>
  )
}

function Observations({
  patients,
  onSaved,
  onError,
}: {
  patients: Patient[]
  onSaved: () => void
  onError: (message: string) => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(patients[0]?.id ?? null)
  const [observations, setObservations] = useState<Observation[]>([])
  const [loading, setLoading] = useState(false)
  const selected = patients.find((patient) => patient.id === selectedId)

  useEffect(() => {
    if (!selectedId) {
      setObservations([])
      return
    }
    setLoading(true)
    api<Observation[]>(`/api/patients/${selectedId}/observations`)
      .then(setObservations)
      .catch((error: unknown) => onError(errorMessage(error)))
      .finally(() => setLoading(false))
  }, [selectedId, onError])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget
    const data = new FormData(form)
    const heartRate = String(data.get('heart_rate') ?? '')
    const respiratoryRate = String(data.get('respiratory_rate') ?? '')
    try {
      await api<Observation>(`/api/patients/${selected.id}/observations`, {
        method: 'POST',
        body: JSON.stringify({
          heart_rate: heartRate ? Number(heartRate) : null,
          respiratory_rate: respiratoryRate ? Number(respiratoryRate) : null,
          notes: String(data.get('notes') ?? '').trim(),
        }),
      })
      form.reset()
      const updated = await api<Observation[]>(`/api/patients/${selected.id}/observations`)
      setObservations(updated)
      onSaved()
    } catch (error) {
      onError(errorMessage(error))
    }
  }

  useEffect(() => {
    if (!selectedId && patients[0]) setSelectedId(patients[0].id)
  }, [selectedId, patients])

  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Clinical review support</p><h2>Observations</h2>
        <p className="muted">Records are append-only and linked to the selected patient.</p></div></div>
      {patients.length === 0 ? <EmptyState message="Register a patient before recording observations." /> : (
        <div className="observation-layout">
          <section className="card patient-list">
            <p className="eyebrow">Select patient</p>
            {patients.map((patient) => (
              <button className={`patient-select ${patient.id === selectedId ? 'selected' : ''}`} key={patient.id}
                onClick={() => setSelectedId(patient.id)}>
                <div className="avatar">{initials(patient.name)}</div>
                <div><strong>{patient.name}</strong><span>{patient.external_id} · {patient.reason}</span></div>
                <ChevronRight />
              </button>
            ))}
          </section>
          {selected && (
            <section className="card observation-detail">
              <div className="detail-header"><div><p className="eyebrow">Observation history</p>
                <h3>{selected.name} <span className={`status ${selected.acuity.toLowerCase()}`}>{selected.acuity}</span></h3>
                <p className="muted">{selected.external_id} · {selected.age} years · {selected.status}</p></div></div>
              <form className="observation-form" onSubmit={submit}>
                <label>Heart rate (bpm)<input name="heart_rate" type="number" min="20" max="250" /></label>
                <label>Respiratory rate (/min)<input name="respiratory_rate" type="number" min="4" max="80" /></label>
                <label>Notes<textarea name="notes" maxLength={2000} placeholder="Optional staff observation" /></label>
                <button className="primary-btn" type="submit"><Check /> Save observation</button>
              </form>
              <div className="history"><p className="eyebrow">Previous records</p>
                {loading ? <p className="muted">Loading observation history…</p> : observations.length === 0
                  ? <p className="muted">No observations recorded.</p>
                  : observations.map((observation) => (
                    <div className="history-row" key={observation.id}>
                      <span>{timeLabel(observation.created_at)}</span>
                      <div>
                        <strong>{[
                          observation.heart_rate !== null && `Heart rate ${observation.heart_rate} bpm`,
                          observation.respiratory_rate !== null && `Respiratory rate ${observation.respiratory_rate}/min`,
                        ].filter(Boolean).join(' · ') || 'Staff note'}</strong>
                        {observation.notes && <p>{observation.notes}</p>}
                      </div>
                      <span className="tag">Recorded</span>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </div>
      )}
      <div className="demo-disclaimer"><AlertCircle /> This prototype is not clinical guidance; measurements must be reviewed by qualified staff.</div>
    </>
  )
}

function Alerts({ alerts, onResolve }: { alerts: Alert[]; onResolve: (alert: Alert) => void }) {
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Action center</p><h2>Alerts</h2>
        <p className="muted">Resolve a prompt only after staff review.</p></div></div>
      {alerts.length === 0 ? <EmptyState message="No open alerts." /> : (
        <div className="alert-list">
          {alerts.map((alert) => (
            <div className="card alert-card" key={alert.id}>
              <div className={`alert-icon ${alert.kind}`}><Bell /></div>
              <div className="alert-body">
                <div><strong>{alert.title}</strong><span className="alert-type">{alert.kind}</span></div>
                <p>{alert.body}</p><small>{timeLabel(alert.created_at)}</small>
              </div>
              <button className="primary-btn small" onClick={() => onResolve(alert)}>Mark reviewed <Check /></button>
            </div>
          ))}
        </div>
      )}
      <div className="demo-disclaimer"><AlertCircle /> Alerts are workflow reminders, not diagnoses or automated clinical decisions.</div>
    </>
  )
}

function AnalyticsView({ analytics, patients }: { analytics: Analytics; patients: Patient[] }) {
  const activePatients = patients.filter((patient) => patient.status !== 'Discharged')
  const longestWait = activePatients.reduce((maximum, patient) => Math.max(maximum, waitMinutes(patient)), 0)
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Recorded activity</p><h2>Analytics</h2>
        <p className="muted">Operational counts calculated from the current fictional records.</p></div></div>
      <div className="metric-grid">
        <Metric icon={Users} label="Total arrivals" value={analytics.arrivals} detail="Saved patient records" tone="blue" />
        <Metric icon={Clock3} label="Waiting" value={analytics.status_counts.Waiting} detail="Current workflow status" tone="amber" />
        <Metric icon={Clock3} label="Longest current wait" value={`${longestWait} min`} detail="Based on recorded arrival time" tone="amber" />
        <Metric icon={Activity} label="In treatment" value={analytics.in_treatment} detail="Current patient status" tone="purple" />
        <Metric icon={Activity} label="Reassessment" value={analytics.status_counts.Reassessment} detail="Awaiting staff review" tone="red" />
        <Metric icon={Check} label="Discharged" value={analytics.discharged} detail="Marked by staff" tone="teal" />
      </div>
      <section className="card">
        <div className="card-heading"><div><p className="eyebrow">Acuity mix</p><h3>Current active queue</h3></div></div>
        <div className="logic-list">
          {(['Critical', 'Urgent', 'Standard'] as Acuity[]).map((acuity) => (
            <span key={acuity}><i className={`dot ${acuity.toLowerCase()}`} /> {acuity}
              <b>{analytics.acuity_mix[acuity] ?? 0}</b></span>
          ))}
        </div>
        {activePatients.length === 0 && <p className="muted">No active patient records.</p>}
      </section>
      <div className="demo-disclaimer"><FileBarChart /> Operational metrics only; this prototype makes no clinical outcome claims.</div>
    </>
  )
}

function RegisterModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="register-heading">
        <div className="modal-head"><div><p className="eyebrow">New encounter</p><h2 id="register-heading">Register patient</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X /></button></div>
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <label>Patient name<input name="name" minLength={2} maxLength={160} placeholder="Fictional name" autoFocus required /></label>
            <label>Age<input name="age" type="number" min="0" max="120" placeholder="Age" required /></label>
          </div>
          <label>Presenting concern<input name="reason" minLength={2} maxLength={500} placeholder="What brought the patient in?" required /></label>
          <label>Initial notes<textarea name="notes" maxLength={2000} placeholder="Optional staff handover notes" /></label>
          <div className="demo-disclaimer"><AlertCircle /> Fictional demonstration record. A clinician must complete triage and assign acuity.</div>
          <div className="modal-actions">
            <button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
            <button className="primary-btn" type="submit">Register patient <ArrowUpRight /></button>
          </div>
        </form>
      </section>
    </div>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof Users
  label: string
  value: string | number
  detail: string
  tone: string
}) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`}><Icon /></div>
      <span>{label}</span><strong>{value}</strong><small>{detail}</small>
    </div>
  )
}

function Capacity({ resource }: { resource: Resource }) {
  const percentage = resource.total ? (resource.used / resource.total) * 100 : 0
  const tone = percentage >= 75 ? 'amber' : 'teal'
  return (
    <div className="capacity">
      <div><span>{resource.name}</span><b>{resource.used} <small>/ {resource.total} · {Math.round(percentage)}% utilized</small></b></div>
      <div className="progress"><i className={tone} style={{ width: `${percentage}%` }} /></div>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return <div className="empty"><Search /><strong>{message}</strong><span>Refresh the records or change your selection.</span></div>
}
