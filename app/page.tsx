'use client'

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Ambulance as AmbulanceIcon,
  BedDouble,
  Bell,
  Bot,
  Check,
  ChevronRight,
  ClipboardList,
  Clock3,
  Copy,
  FileBarChart,
  FileText,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  ShieldAlert,
  Stethoscope,
  Users,
  X,
  Zap,
} from 'lucide-react'
import { api, downloadFile, setAccessToken } from '@/lib/api'
import dynamic from 'next/dynamic'

const AmbulanceDashboard = dynamic(() => import('@/components/ambulance-dashboard'), {
  loading: () => <div className="card map-loading">Loading ambulance tracking…</div>,
})

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
type ResourceNeed = {
  id: number
  patient_id: number
  resource_id: number
  status: string
  blocked_reason: string
  resource: Resource
  patient: Patient
}
type Referral = {
  id: number
  patient_id: number
  department: string
  urgency: string
  reason: string
  status: string
  created_at: string
  patient: Patient
}
type AmbulanceRecord = {
  code: string
  direction: 'INBOUND' | 'OUTBOUND'
  origin: string
  destination: string
  destination_lat: number
  destination_lng: number
  lat: number | null
  lng: number | null
  speed: number
  heading: number
  last_updated: string | null
  gps_lost: boolean
  trail: { lat: number; lng: number; created_at: string }[]
}
type SmsEntry = {
  id: number
  patient_id: number
  phone: string
  message: string
  status: string
  created_at: string
}
type Alert = {
  id: number
  kind: string
  title: string
  body: string
  patient_id: number | null
  resolved: boolean
  resolution_reason: string
  created_at: string
}
type DemoControlAction = 'worsen-vitals' | 'scanner-offline' | 'dismiss-flag' | 'late-update'
type AbcdeFinding = 'Clear' | 'Concern' | 'Not assessed'
type Observation = {
  id: number
  patient_id: number
  heart_rate: number | null
  respiratory_rate: number | null
  systolic_bp: number | null
  diastolic_bp: number | null
  spo2: number | null
  airway: AbcdeFinding | null
  breathing: AbcdeFinding | null
  circulation: AbcdeFinding | null
  disability: AbcdeFinding | null
  exposure: AbcdeFinding | null
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
  resourceNeeds: ResourceNeed[]
  referrals: Referral[]
  ambulances: AmbulanceRecord[]
  smsOutbox: SmsEntry[]
  alerts: Alert[]
  analytics: Analytics
}

const nav = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Patient queue', icon: ClipboardList },
  { label: 'ABCDE triage', icon: Stethoscope },
  { label: 'Resources', icon: BedDouble },
  { label: 'Ambulances', icon: AmbulanceIcon },
  { label: 'Referrals', icon: FileText },
  { label: 'SMS outbox', icon: Mail },
  { label: 'Observations', icon: Activity },
  { label: 'AI Assist', icon: Bot },
  { label: 'Alerts', icon: Bell },
  { label: 'Analytics', icon: FileBarChart },
]

const emptyWorkspace: Workspace = {
  patients: [],
  resources: [],
  resourceNeeds: [],
  referrals: [],
  ambulances: [],
  smsOutbox: [],
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

function estimateEtaMinutes(ambulance: AmbulanceRecord) {
  if (ambulance.lat === null || ambulance.lng === null || ambulance.speed <= 1) return null
  const radians = (value: number) => value * Math.PI / 180
  const [lat1, lng1] = [ambulance.lat, ambulance.lng].map(radians)
  const [lat2, lng2] = [ambulance.destination_lat, ambulance.destination_lng].map(radians)
  const dLat = lat2 - lat1
  const dLng = lng2 - lng1
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  const distance = 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
  return Math.ceil(distance / ambulance.speed * 60)
}

type AssistantMessage = { id: string; role: 'user' | 'assistant'; text: string }

function acuityLabel(acuity: Acuity) {
  if (acuity === 'Critical') return 'Immediate · Red'
  if (acuity === 'Urgent') return 'Delayed · Yellow'
  return 'Standard · Green'
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
  const [discharging, setDischarging] = useState<Patient | null>(null)
  const [reportPatient, setReportPatient] = useState<Patient | null>(null)
  const [referringPatient, setReferringPatient] = useState<Patient | null>(null)
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
      const [patients, resources, resourceNeeds, referrals, ambulanceResponse, smsOutbox, alerts, analytics] = await Promise.all([
        api<Patient[]>('/api/patients'),
        api<Resource[]>('/api/resources'),
        api<ResourceNeed[]>('/api/resource-needs'),
        api<Referral[]>('/api/referrals'),
        api<{ ambulances: AmbulanceRecord[] }>('/api/ambulances?include_trail=false'),
        api<SmsEntry[]>('/api/sms-outbox'),
        api<Alert[]>('/api/alerts'),
        api<Analytics>('/api/analytics'),
      ])
      setWorkspace({ patients, resources, resourceNeeds, referrals, ambulances: ambulanceResponse.ambulances, smsOutbox, alerts, analytics })
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
          acuity: String(data.get('acuity') ?? ''),
          notes: String(data.get('notes') ?? '').trim(),
        }),
      })
      setShowRegister(false)
      notify('Patient registered with staff-selected acuity.')
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
    if (update.status === 'Discharged' && patient.status !== 'Discharged') {
      setDischarging(patient)
      return
    }
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

  const completeDischarge = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!discharging) return
    const data = new FormData(event.currentTarget)
    try {
      await api<Patient>(`/api/patients/${discharging.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'Discharged',
          outcome: String(data.get('outcome') ?? '').trim(),
          advice: String(data.get('advice') ?? '').trim(),
        }),
      })
      setReportPatient({ ...discharging, status: 'Discharged' })
      setDischarging(null)
      notify(`${discharging.external_id} discharged. Final report is ready.`)
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  const requestResource = async (resource: Resource, patientId: number) => {
    try {
      await api(`/api/resources/${resource.id}/needs`, {
        method: 'POST',
        body: JSON.stringify({ patient_id: patientId }),
      })
      notify(`${resource.name} need recorded.`)
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  const updateResourceNeed = async (need: ResourceNeed, status: 'Needed' | 'Used') => {
    try {
      await api(`/api/resource-needs/${need.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      notify(status === 'Used' ? `${need.resource.name} marked as used.` : `${need.resource.name} marked as needed.`)
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  const createReferral = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!referringPatient) return
    const data = new FormData(event.currentTarget)
    try {
      await api(`/api/patients/${referringPatient.id}/referrals`, {
        method: 'POST',
        body: JSON.stringify({
          department: data.get('department'),
          urgency: data.get('urgency'),
          reason: String(data.get('reason') ?? '').trim(),
        }),
      })
      notify(`Referral requested for ${referringPatient.external_id}.`)
      setReferringPatient(null)
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  const updateReferral = async (referral: Referral, status: string) => {
    try {
      await api(`/api/referrals/${referral.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      notify(`Referral marked ${status.toLowerCase()}.`)
      await loadWorkspace()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  const runDemoControl = async (action: DemoControlAction, reason = ''): Promise<boolean> => {
    try {
      const body = action === 'dismiss-flag' ? { reason } : undefined
      await api(`/api/demo-controls/${action}`, {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const messages: Record<DemoControlAction, string> = {
        'worsen-vitals': 'Fictional worsened vitals recorded. The patient is flagged to look again; acuity was not changed.',
        'scanner-offline': 'Scanner marked offline. Affected patient and resource blocked flag updated.',
        'dismiss-flag': `Flag dismissed with reason: ${reason}`,
        'late-update': 'Late patient update received. Queue refreshed from saved records.',
      }
      notify(messages[action])
      await loadWorkspace()
      return true
    } catch (error) {
      notify(errorMessage(error))
      return false
    }
  }

  const updateResource = async (resource: Resource, used: number, status?: 'Operational' | 'Offline') => {
    if (!Number.isInteger(used) || used < 0 || used > resource.total) {
      notify(`Enter a whole number between 0 and ${resource.total}.`)
      return
    }
    try {
      await api<Resource>(`/api/resources/${resource.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ used, status }),
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
    (sum, resource) => sum + (resource.status === 'Offline' ? 0 : Math.max(0, resource.total - resource.used)),
    0,
  )
  const totalResources = workspace.resources.reduce((sum, resource) => sum + resource.total, 0)

  return (
    <div className="app-shell">
      <aside className={`sidebar ${showMobileNav ? 'mobile-open' : ''}`}>
        <div className="brand">
          <span className="brand-mark"><HeartPulse /></span>
          <span>THE NEW <span>2026</span></span>
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
              ambulances={workspace.ambulances}
              alerts={workspace.alerts}
              analytics={workspace.analytics}
              longestWait={longestWait}
              availableResources={availableResources}
              totalResources={totalResources}
              onRegister={() => setShowRegister(true)}
              onReassess={requestReassessment}
              onNavigate={setActive}
              onDemoAction={runDemoControl}
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
          {active === 'ABCDE triage' && (
            <ABCDE
              patients={workspace.patients.filter((patient) => patient.status !== 'Discharged')}
              onSaved={async () => {
                notify('ABCDE assessment saved for staff review.')
                await loadWorkspace()
              }}
              onError={notify}
            />
          )}
          {active === 'Resources' && (
            <Resources
              resources={workspace.resources}
              patients={workspace.patients.filter((patient) => patient.status !== 'Discharged')}
              needs={workspace.resourceNeeds}
              canManage={canManageResources}
              onUpdate={updateResource}
              onRequest={requestResource}
              onNeedUpdate={updateResourceNeed}
            />
          )}
          {active === 'Ambulances' && <AmbulanceDashboard onError={notify} />}
          {active === 'Referrals' && (
            <Referrals
              referrals={workspace.referrals}
              patients={workspace.patients.filter((patient) => patient.status !== 'Discharged')}
              onRefer={setReferringPatient}
              onUpdate={updateReferral}
            />
          )}
          {active === 'SMS outbox' && <SmsOutbox entries={workspace.smsOutbox} />}
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
          {active === 'AI Assist' && (
            <AIAssist
              patients={workspace.patients.filter((patient) => patient.status !== 'Discharged')}
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
      {discharging && (
        <DischargeModal
          patient={discharging}
          onClose={() => setDischarging(null)}
          onSubmit={completeDischarge}
        />
      )}
      {reportPatient && (
        <FinalReportModal
          patient={reportPatient}
          onClose={() => setReportPatient(null)}
          onError={notify}
          onSent={async () => {
            notify('SMS saved to the outbox.')
            await loadWorkspace()
          }}
        />
      )}
      {referringPatient && (
        <ReferralModal
          patient={referringPatient}
          onClose={() => setReferringPatient(null)}
          onSubmit={createReferral}
        />
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
          <span>THE NEW <span>2026</span></span>
        </div>
        <div className="login-copy">
          <p className="eyebrow">Emergency operations platform</p>
          <h1>Clarity when every<br /><em>second counts.</em></h1>
          <p>Coordinate triage, resources, observations, and staff response from one calm command center.</p>
        </div>
        <div className="login-footer">Northstar General Hospital <span>•</span> 2026 triage prototype</div>
      </div>
      <div className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <div className="security-icon"><ShieldCheck /></div>
          <h2>Staff sign in</h2>
          <p>Use your authorized hospital account to continue.</p>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <label>Username or email
            <input
              autoComplete="username"
              type="text"
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

function DemoControls({
  alerts,
  onRun,
}: {
  alerts: Alert[]
  onRun: (action: DemoControlAction, reason?: string) => Promise<boolean>
}) {
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState<DemoControlAction | null>(null)

  const run = async (action: DemoControlAction) => {
    if (action === 'dismiss-flag' && reason.trim().length < 3) return
    setWorking(action)
    try {
      const succeeded = await onRun(action, reason.trim())
      if (succeeded && action === 'dismiss-flag') setReason('')
    } finally {
      setWorking(null)
    }
  }

  return (
    <section className="card demo-controls" aria-labelledby="demo-controls-heading">
      <div className="card-heading">
        <div><p className="eyebrow">Live demo</p><h3 id="demo-controls-heading">Demo controls</h3></div>
        <span className="tag">Fictional data · {alerts.length} open flags</span>
      </div>
      <div className="demo-control-grid">
        <button className="outline-btn" disabled={working !== null} onClick={() => void run('worsen-vitals')}>
          {working === 'worsen-vitals' ? 'Updating…' : 'Worsen vitals · Look again'}
        </button>
        <button className="outline-btn" disabled={working !== null} onClick={() => void run('scanner-offline')}>
          {working === 'scanner-offline' ? 'Updating…' : 'Set scanner offline'}
        </button>
        <div className="demo-dismiss">
          <input
            aria-label="Reason for dismissing a flag"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="Reason to dismiss a flag"
          />
          <button
            className="outline-btn"
            disabled={working !== null || alerts.length === 0 || reason.trim().length < 3}
            onClick={() => void run('dismiss-flag')}
          >
            {working === 'dismiss-flag' ? 'Updating…' : 'Dismiss flag with reason'}
          </button>
        </div>
        <button className="primary-btn" disabled={working !== null} onClick={() => void run('late-update')}>
          {working === 'late-update' ? 'Updating…' : 'Send late update · Refresh queue'}
        </button>
      </div>
      <p className="card-note">Actions save to the API. Dismissing a flag records your reason and does not change triage level.</p>
    </section>
  )
}

function Overview({
  user,
  patients,
  resources,
  ambulances,
  alerts,
  analytics,
  longestWait,
  availableResources,
  totalResources,
  onRegister,
  onReassess,
  onNavigate,
  onDemoAction,
}: {
  user: User
  patients: Patient[]
  resources: Resource[]
  ambulances: AmbulanceRecord[]
  alerts: Alert[]
  analytics: Analytics
  longestWait: number
  availableResources: number
  totalResources: number
  onRegister: () => void
  onReassess: (patient: Patient) => void
  onNavigate: (page: string) => void
  onDemoAction: (action: DemoControlAction, reason?: string) => Promise<boolean>
}) {
  const firstName = fullName(user).replace(/^(Dr\.?|Mr\.|Mrs\.|Ms\.)\s+/i, '').split(/\s+/)[0]
  const inbound = ambulances.filter((ambulance) => ambulance.direction === 'INBOUND' && !ambulance.gps_lost)
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
      {inbound.length > 0 && (
        <button className="incoming-banner" onClick={() => onNavigate('Ambulances')}>
          <AmbulanceIcon />
          <span><strong>{inbound.length} ambulance{inbound.length === 1 ? '' : 's'} incoming</strong><small>Live GPS estimates · Open tracking</small></span>
          <span className="incoming-estimate">{inbound.map((ambulance) => {
            const eta = estimateEtaMinutes(ambulance)
            return `${ambulance.code} ${eta === null ? '—' : `${eta} min`}`
          }).join(' · ')}</span>
          <ArrowUpRight />
        </button>
      )}
      {alerts.length > 0 && (
        <div className="notice">
          <AlertCircle />
          <div><strong>{alerts.length} item{alerts.length === 1 ? '' : 's'} need staff review</strong>
            <span>Review alerts are advisory and do not change acuity automatically.</span></div>
          <button onClick={() => onNavigate('Alerts')}>Review alerts <ArrowUpRight /></button>
        </div>
      )}
      <DemoControls alerts={alerts} onRun={onDemoAction} />
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
              <span key={acuity}><i className={`dot ${acuity.toLowerCase()}`} /> {acuityLabel(acuity)}<b>{analytics.acuity_mix[acuity] ?? 0}</b></span>
            ))}
          </div>
          <p className="card-note">Staff-selected triage categories. The prototype does not assign priority or provide clinical recommendations.</p>
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
              <button className={filter === value ? 'selected' : ''} key={value} onClick={() => setFilter(value)}>
                {value === 'Critical' ? 'Immediate · Red' : value === 'Urgent' ? 'Delayed · Yellow' : value === 'Standard' ? 'Standard · Green' : value}
              </button>
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
          <span className={`acuity ${patient.acuity.toLowerCase()}`} title={acuityLabel(patient.acuity)}>
            {patient.acuity === 'Critical' ? '1' : patient.acuity === 'Urgent' ? '2' : '3'}
          </span>
          <span className={`acuity-label ${patient.acuity.toLowerCase()}`}>{acuityLabel(patient.acuity)}</span>
          <div className="patient-info">
            <strong>{patient.name}</strong>
            <span>{patient.external_id} · {patient.age} · {patient.reason}</span>
            <span>Arrived {timeLabel(patient.created_at)} · Updated {timeLabel(patient.updated_at)}</span>
          </div>
          <span className="wait-time"><Clock3 /> {waitMinutes(patient)} min</span>
          {editable && onUpdate ? (
            <>
              <select aria-label={`Triage category for ${patient.name}`} value={patient.acuity}
                onChange={(event) => onUpdate(patient, { acuity: event.target.value as Acuity })}>
                <option value="Critical">Immediate · Red</option><option value="Urgent">Delayed · Yellow</option><option value="Standard">Standard · Green</option>
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
  patients,
  needs,
  canManage,
  onUpdate,
  onRequest,
  onNeedUpdate,
}: {
  resources: Resource[]
  patients: Patient[]
  needs: ResourceNeed[]
  canManage: boolean
  onUpdate: (resource: Resource, used: number, status?: 'Operational' | 'Offline') => void
  onRequest: (resource: Resource, patientId: number) => void
  onNeedUpdate: (need: ResourceNeed, status: 'Needed' | 'Used') => void
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
                    const formData = new FormData(event.currentTarget)
                    const value = Number(formData.get('used'))
                    onUpdate(resource, value, String(formData.get('availability')) as 'Operational' | 'Offline')
                  }}>
                    <label>In use
                      <input name="used" type="number" min="0" max={resource.total} defaultValue={resource.used} required />
                    </label>
                    <label className="resource-status-select">Availability
                      <select name="availability" defaultValue={resource.status === 'Offline' ? 'Offline' : 'Operational'}>
                        <option value="Operational">Operational</option>
                        <option value="Offline">Offline</option>
                      </select>
                    </label>
                    <button className="outline-btn" type="submit">Save</button>
                  </form>
                ) : <p className="card-note">Only physicians and administrators can update capacity.</p>}
              </section>
            )
          })}
        </div>
      )}
      <section className="card need-resource-card">
        <div className="card-heading"><div><p className="eyebrow">Patient requests</p><h3>Record a resource need</h3></div><Activity /></div>
        {patients.length === 0 || resources.length === 0 ? <EmptyState message="Add an active patient and available resource record first." /> : (
          <form className="resource-need-form" onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const resource = resources.find((item) => item.id === Number(data.get('resource_id')))
            if (resource) onRequest(resource, Number(data.get('patient_id')))
          }}>
            <label>Patient<select name="patient_id" required defaultValue=""><option value="" disabled>Select patient</option>
              {patients.map((patient) => <option value={patient.id} key={patient.id}>{patient.name} · {patient.external_id}</option>)}
            </select></label>
            <label>Resource<select name="resource_id" required defaultValue=""><option value="" disabled>Select resource</option>
              {resources.map((resource) => <option value={resource.id} key={resource.id}>{resource.name}</option>)}
            </select></label>
            <button type="submit" className="primary-btn"><Plus /> Record need</button>
          </form>
        )}
      </section>
      <section className="card resource-need-list">
        <div className="card-heading"><div><p className="eyebrow">Assignment log</p><h3>Patient resource needs</h3></div><span className="tag">{needs.length} logged</span></div>
        {needs.length === 0 ? <EmptyState message="No patient resource needs recorded." /> : needs.map((need) => (
          <div className="need-row" key={need.id}>
            <div><strong>{need.patient.name}</strong><small>{need.patient.external_id} · {need.resource.name}</small></div>
            <div className="need-state">
              <span className={`status ${need.status.toLowerCase()}`}>{need.status}</span>
              {need.status === 'Blocked' && <span className="blocked-flag"><ShieldAlert /> Resource blocked · {need.blocked_reason}</span>}
            </div>
            {need.status !== 'Used' && need.status !== 'Blocked' && (
              <button className="outline-btn" onClick={() => onNeedUpdate(need, 'Used')}>Mark used</button>
            )}
            {need.status === 'Used' && (
              <button className="text-btn" onClick={() => onNeedUpdate(need, 'Needed')}>Undo used</button>
            )}
          </div>
        ))}
      </section>
      <div className="card safety-callout"><ShieldCheck /><div><strong>Staff-controlled capacity</strong>
        <span>THE NEW 2026 does not assign patients to resources. Clinical decisions remain with qualified staff.</span></div></div>
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
    const systolicBp = String(data.get('systolic_bp') ?? '')
    const diastolicBp = String(data.get('diastolic_bp') ?? '')
    const spo2 = String(data.get('spo2') ?? '')
    try {
      await api<Observation>(`/api/patients/${selected.id}/observations`, {
        method: 'POST',
        body: JSON.stringify({
          heart_rate: heartRate ? Number(heartRate) : null,
          respiratory_rate: respiratoryRate ? Number(respiratoryRate) : null,
          systolic_bp: systolicBp ? Number(systolicBp) : null,
          diastolic_bp: diastolicBp ? Number(diastolicBp) : null,
          spo2: spo2 ? Number(spo2) : null,
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
                <h3>{selected.name} <span className={`status ${selected.acuity.toLowerCase()}`}>{acuityLabel(selected.acuity)}</span></h3>
                <p className="muted">{selected.external_id} · {selected.age} years · {selected.status}</p></div></div>
              <form className="observation-form" onSubmit={submit}>
                <label>Heart rate (bpm)<input name="heart_rate" type="number" min="20" max="250" /></label>
                <label>Respiratory rate (/min)<input name="respiratory_rate" type="number" min="4" max="80" /></label>
                <label>Blood pressure (mmHg)
                  <span className="paired-inputs">
                    <input name="systolic_bp" type="number" min="40" max="300" aria-label="Systolic blood pressure" placeholder="Systolic" />
                    <span>/</span>
                    <input name="diastolic_bp" type="number" min="20" max="200" aria-label="Diastolic blood pressure" placeholder="Diastolic" />
                  </span>
                </label>
                <label>SpO₂ (%)<input name="spo2" type="number" min="0" max="100" /></label>
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
                          observation.systolic_bp !== null && observation.diastolic_bp !== null && `BP ${observation.systolic_bp}/${observation.diastolic_bp} mmHg`,
                          observation.spo2 !== null && `SpO₂ ${observation.spo2}%`,
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

function ABCDE({
  patients,
  onSaved,
  onError,
}: {
  patients: Patient[]
  onSaved: () => void
  onError: (message: string) => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(patients[0]?.id ?? null)
  const selected = patients.find((patient) => patient.id === selectedId)
  const steps = [
    { key: 'airway', letter: 'A', title: 'Airway', prompt: 'Record the observed airway assessment.' },
    { key: 'breathing', letter: 'B', title: 'Breathing', prompt: 'Record the observed breathing assessment.' },
    { key: 'circulation', letter: 'C', title: 'Circulation', prompt: 'Record the observed circulation assessment.' },
    { key: 'disability', letter: 'D', title: 'Disability', prompt: 'Record the observed disability assessment.' },
    { key: 'exposure', letter: 'E', title: 'Exposure', prompt: 'Record the observed exposure assessment.' },
  ] as const

  useEffect(() => {
    if (!selectedId && patients[0]) setSelectedId(patients[0].id)
  }, [selectedId, patients])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget
    const data = new FormData(form)
    const findings = Object.fromEntries(
      steps.map(({ key }) => [key, String(data.get(key) ?? '')]),
    )
    try {
      await api<Observation>(`/api/patients/${selected.id}/observations`, {
        method: 'POST',
        body: JSON.stringify({
          ...findings,
          notes: String(data.get('notes') ?? '').trim(),
        }),
      })
      form.reset()
      onSaved()
    } catch (error) {
      onError(errorMessage(error))
    }
  }

  return (
    <>
      <div className="page-heading">
        <div><p className="eyebrow">Structured primary survey</p><h2>ABCDE triage</h2>
          <p className="muted">Record staff-observed findings in sequence. This form does not assign acuity.</p></div>
      </div>
      {patients.length === 0 ? <EmptyState message="Register a patient before starting an ABCDE assessment." /> : (
        <div className="abcde-layout">
          <section className="card abcde-intro">
            <div className="assist-icon"><Stethoscope /></div>
            <div><p className="eyebrow">Primary survey</p><h3>Assess in order. Record what you observe.</h3>
              <p>Use your training and local emergency protocol. Escalate immediately through your facility process when clinically concerned.</p></div>
            <label className="patient-picker">Patient
              <select value={selectedId ?? ''} onChange={(event) => setSelectedId(Number(event.target.value))}>
                {patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.name} · {patient.external_id}</option>)}
              </select>
            </label>
          </section>
          {selected && (
            <form className="card abcde-form" onSubmit={submit}>
              <div className="card-heading"><div><p className="eyebrow">Assessment record</p>
                <h3>{selected.name} <span className={`status ${selected.acuity.toLowerCase()}`}>{acuityLabel(selected.acuity)}</span></h3>
                <p className="muted">{selected.age} years · {selected.reason}</p></div></div>
              <div className="abcde-steps">
                {steps.map(({ key, letter, title, prompt }) => (
                  <label className="abcde-step" key={key}>
                    <span className="abcde-letter">{letter}</span>
                    <span className="abcde-copy"><strong>{title}</strong><small>{prompt}</small></span>
                    <select name={key} defaultValue="" required aria-label={`${title} assessment`}>
                      <option value="" disabled>Select finding</option>
                      <option value="Clear">No concern observed</option>
                      <option value="Concern">Concern observed</option>
                      <option value="Not assessed">Not assessed</option>
                    </select>
                  </label>
                ))}
              </div>
              <label className="abcde-notes">Assessment notes
                <textarea name="notes" maxLength={2000} placeholder="Document relevant findings and context for the care team." />
              </label>
              <div className="modal-actions">
                <span className="muted">Saved to this patient’s observation history.</span>
                <button className="primary-btn" type="submit"><Check /> Save assessment</button>
              </div>
            </form>
          )}
        </div>
      )}
      <div className="demo-disclaimer"><AlertCircle /> Training workflow only. ABCDE entries are not a diagnosis and do not replace qualified clinical assessment.</div>
    </>
  )
}

function answerPatientQuestion(question: string, patient: Patient, observations: Observation[]) {
  const query = question.toLowerCase()
  const airway = observations.find((record) => record.airway !== null)?.airway
  const breathing = observations.find((record) => record.breathing !== null)?.breathing
  const circulation = observations.find((record) => record.circulation !== null)?.circulation
  const disability = observations.find((record) => record.disability !== null)?.disability
  const exposure = observations.find((record) => record.exposure !== null)?.exposure
  const heartRate = observations.find((record) => record.heart_rate !== null)?.heart_rate
  const respiratoryRate = observations.find((record) => record.respiratory_rate !== null)?.respiratory_rate
  const bloodPressure = observations.find((record) => record.systolic_bp !== null && record.diastolic_bp !== null)
  const spo2 = observations.find((record) => record.spo2 !== null)?.spo2
  const concerns = [
    airway === 'Concern' && 'A · Airway',
    breathing === 'Concern' && 'B · Breathing',
    circulation === 'Concern' && 'C · Circulation',
    disability === 'Concern' && 'D · Disability',
    exposure === 'Concern' && 'E · Exposure',
  ].filter((value): value is string => Boolean(value))

  if (/\b(diagnos|treat|treatment|medication|medicine|prescri|prognos|what should (i|we) do|recommend.*care)\b/.test(query)) {
    return 'I can’t diagnose, recommend treatment, or decide triage priority. Please review the patient directly and follow your facility’s clinical escalation process.'
  }
  if (/^(hi|hello|hey|good morning|good afternoon)\b/.test(query.trim())) {
    return `Hello. I can help review ${patient.name}’s saved chart information. Try asking for a summary, vital signs, ABCDE findings, recorded concerns, or missing fields.`
  }
  if (/\b(help|what can you|what do you do)\b/.test(query)) {
    return 'I can summarize the selected patient’s saved record, list recorded vitals, review saved ABCDE entries and staff-marked concerns, or identify fields with no entry. My replies use fixed rules and chart data; they are not clinical advice.'
  }
  if (/\b(missing|not recorded|no entry|no data|without entry|incomplete|what.*need.*fill|what.*not.*entered)\b/.test(query)) {
    const missing = [
      heartRate === undefined && 'heart rate',
      respiratoryRate === undefined && 'respiratory rate',
      !bloodPressure && 'blood pressure',
      spo2 === undefined && 'SpO₂',
      !airway && 'airway',
      !breathing && 'breathing',
      !circulation && 'circulation',
      !disability && 'disability',
      !exposure && 'exposure',
    ].filter((value): value is string => Boolean(value))
    return missing.length
      ? `I found no saved entry for: ${missing.join(', ')}. This only describes the chart; it does not determine what assessments are clinically needed.`
      : 'The chart has an entry for each supported vital and ABCDE field. Please check the saved values and timestamps with the care team.'
  }
  if (/\b(concern|concerns|flag|flags|abnormal|review|escalat)\b/.test(query)) {
    return concerns.length
      ? `The chart marks a concern for ${concerns.join(', ')}. This is a staff-recorded finding, not an automated interpretation. Review it with qualified staff and follow your local escalation protocol.`
      : 'I found no ABCDE field marked “Concern” in the saved entries. That does not establish that the patient is well; review the patient and chart with qualified staff.'
  }
  if (/\b(abcde|airway|breathing|circulation|disability|exposure)\b/.test(query)) {
    const finding = (value: AbcdeFinding | null | undefined) => value ?? 'Not recorded'
    return `Saved ABCDE entries: A · Airway: ${finding(airway)}; B · Breathing: ${finding(breathing)}; C · Circulation: ${finding(circulation)}; D · Disability: ${finding(disability)}; E · Exposure: ${finding(exposure)}. These are chart entries only; not recorded is different from normal.`
  }
  if (/\b(vital|blood pressure|\bbp\b|spo2|oxygen|heart rate|\bhr\b|respiratory rate|\brr\b)\b/.test(query)) {
    const vitals = [
      heartRate !== undefined && `Heart rate: ${heartRate} bpm`,
      respiratoryRate !== undefined && `Respiratory rate: ${respiratoryRate}/min`,
      bloodPressure && `Blood pressure: ${bloodPressure.systolic_bp}/${bloodPressure.diastolic_bp} mmHg`,
      spo2 !== undefined && `SpO₂: ${spo2}%`,
    ].filter(Boolean)
    return vitals.length
      ? `Saved vital signs: ${vitals.join('; ')}. Values are copied from observation history; confirm their time and context in the chart.`
      : 'There are no vital signs saved in this patient’s observation history.'
  }
  if (/\b(triage|acuity|priority|category|red|yellow|green)\b/.test(query)) {
    return `The saved staff-selected category is ${acuityLabel(patient.acuity)}. Workflow status: ${patient.status}. This assistant does not assign or change triage priority.`
  }
  if (/\b(history|notes|observation|record|handover|summary|summari[sz]e|patient|who is)\b/.test(query)) {
    const notes = observations
      .filter((record) => record.notes.trim())
      .slice(0, 3)
      .map((record) => `“${record.notes.trim()}” (${timeLabel(record.created_at)})`)
    return [
      `${patient.name} (${patient.external_id}), age ${patient.age}. Presenting concern: ${patient.reason}.`,
      `Staff-selected category: ${acuityLabel(patient.acuity)}. Workflow: ${patient.status}.`,
      `${observations.length} saved observation${observations.length === 1 ? '' : 's'}.`,
      notes.length ? `Recent staff notes: ${notes.join('; ')}` : 'No staff notes are recorded.',
      'I can also list vitals, ABCDE entries, recorded concerns, or fields without an entry.',
    ].join(' ')
  }
  return 'I can answer questions about the selected patient’s saved summary, vitals, ABCDE entries, staff-marked concerns, or missing fields. I can’t interpret symptoms or recommend care.'
}

function AIAssist({
  patients,
  onError,
}: {
  patients: Patient[]
  onError: (message: string) => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(patients[0]?.id ?? null)
  const [observations, setObservations] = useState<Observation[]>([])
  const [loading, setLoading] = useState(false)
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<AssistantMessage[]>([{
    id: 'welcome',
    role: 'assistant',
    text: 'Hello. I can look up this patient’s saved summary, observations, ABCDE entries, recorded concerns, and missing chart fields. What would you like to know?',
  }])
  const selected = patients.find((patient) => patient.id === selectedId)
  const latest = observations[0]

  const askQuestion = (prompt: string) => {
    const text = prompt.trim()
    if (!selected || !text || loading) return
    setMessages((current) => [
      ...current,
      { id: `${Date.now()}-question`, role: 'user', text },
      {
        id: `${Date.now()}-answer`,
        role: 'assistant',
        text: answerPatientQuestion(text, selected, observations),
      },
    ])
    setQuestion('')
  }

  const submitQuestion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    askQuestion(question)
  }

  useEffect(() => {
    if (!selectedId && patients[0]) setSelectedId(patients[0].id)
  }, [selectedId, patients])

  useEffect(() => {
    if (!selectedId) {
      setObservations([])
      return
    }
    let active = true
    setObservations([])
    setLoading(true)
    api<Observation[]>(`/api/patients/${selectedId}/observations`)
      .then((records) => {
        if (active) setObservations(records)
      })
      .catch((error: unknown) => {
        if (active) {
          setObservations([])
          onError(errorMessage(error))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [selectedId, onError])

  const summary = useMemo(() => {
    if (!selected) return { text: '', hasConcern: false }
    const finding = (value: AbcdeFinding | null | undefined) => value ?? 'Not recorded'
    const airway = observations.find((record) => record.airway !== null)?.airway
    const breathing = observations.find((record) => record.breathing !== null)?.breathing
    const circulation = observations.find((record) => record.circulation !== null)?.circulation
    const disability = observations.find((record) => record.disability !== null)?.disability
    const exposure = observations.find((record) => record.exposure !== null)?.exposure
    const heartRate = observations.find((record) => record.heart_rate !== null)?.heart_rate
    const respiratoryRate = observations.find((record) => record.respiratory_rate !== null)?.respiratory_rate
    const bloodPressure = observations.find((record) => record.systolic_bp !== null && record.diastolic_bp !== null)
    const spo2 = observations.find((record) => record.spo2 !== null)?.spo2
    const notes = observations.find((record) => record.notes.trim())?.notes
    const vitals = [
      heartRate !== undefined && `HR ${heartRate} bpm`,
      respiratoryRate !== undefined && `RR ${respiratoryRate}/min`,
      bloodPressure && `BP ${bloodPressure.systolic_bp}/${bloodPressure.diastolic_bp} mmHg`,
      spo2 !== undefined && `SpO₂ ${spo2}%`,
    ].filter(Boolean).join(' · ')
    const concerns = [
      airway === 'Concern' && 'A · Airway',
      breathing === 'Concern' && 'B · Breathing',
      circulation === 'Concern' && 'C · Circulation',
      disability === 'Concern' && 'D · Disability',
      exposure === 'Concern' && 'E · Exposure',
    ].filter((label): label is string => Boolean(label))
    return {
      text: [
        `SITUATION — ${selected.name} (${selected.external_id}), ${selected.age} years. Presenting concern: ${selected.reason}.`,
        `BACKGROUND — Staff-selected category: ${acuityLabel(selected.acuity)}. Workflow status: ${selected.status}.`,
        `ABCDE — A ${finding(airway)} · B ${finding(breathing)} · C ${finding(circulation)} · D ${finding(disability)} · E ${finding(exposure)}.`,
        `RECORDED VITALS — ${vitals || 'No vital signs recorded in observation history.'}`,
        `STAFF NOTES — ${notes?.trim() || 'No notes recorded in observation history.'}`,
        concerns.length
          ? `FOLLOW-UP PROMPT — A concern was recorded for ${concerns.join(', ')}. Promptly review and follow your facility escalation protocol.`
          : 'FOLLOW-UP PROMPT — Confirm assessment completeness and review the record with qualified clinical staff.',
        'This structured handover is informational only. It does not diagnose, recommend treatment, or change triage priority.',
      ].join('\n\n'),
      hasConcern: concerns.length > 0,
    }
  }, [observations, selected])

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summary.text)
    } catch (error) {
      onError(errorMessage(error))
    }
  }

  return (
    <>
      <div className="page-heading">
        <div><p className="eyebrow">Clinical decision support</p><h2>AI Assist</h2>
          <p className="muted">Ask questions about the selected patient’s saved chart entries.</p></div>
      </div>
      <section className="assist-safety" role="note">
        <Bot /><div><strong>Private offline assistant — no AI provider is connected</strong>
          <span>Replies are generated from saved chart fields using local rules. Your questions and patient context are not sent to an AI service. It cannot diagnose, interpret symptoms, or recommend care.</span></div>
      </section>
      {patients.length === 0 ? <EmptyState message="Register a patient before using the handover assistant." /> : (
        <div className="assist-layout">
          <section className="card assist-context">
            <div className="assist-icon"><ClipboardList /></div>
            <p className="eyebrow">Patient context</p><h3>Choose a record to review</h3>
            <label className="patient-picker">Patient
              <select value={selectedId ?? ''} onChange={(event) => {
                setSelectedId(Number(event.target.value))
                setObservations([])
                setMessages([{
                  id: `welcome-${event.target.value}`,
                  role: 'assistant',
                  text: 'Hello. I can look up this patient’s saved summary, observations, ABCDE entries, recorded concerns, and missing chart fields. What would you like to know?',
                }])
              }}>
                {patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.name} · {patient.external_id}</option>)}
              </select>
            </label>
            {selected && <div className="assist-patient">
              <strong>{selected.name}</strong><span>{selected.age} years · {selected.status}</span>
              <span>{selected.reason}</span>
              <span className={`status ${selected.acuity.toLowerCase()}`}>{acuityLabel(selected.acuity)}</span>
            </div>}
            <div className="safety-note"><ShieldCheck /><span>Use qualified clinical judgment and your facility’s escalation pathway. The assistant never changes acuity.</span></div>
          </section>
          <section className="card assist-output chat-panel">
            <div className="card-heading"><div><p className="eyebrow">Offline chart assistant</p><h3>Ask about this patient</h3></div>
              <span className="assistant-local"><span className="live-dot" /> Local only</span>
            </div>
            {loading && <p className="muted" aria-live="polite">Loading saved observations…</p>}
            <div className="chat-messages" role="log" aria-live="polite" aria-label="Assistant conversation">
              {messages.map((message) => (
                <div className={`chat-message ${message.role}`} key={message.id}>
                  <span className="chat-speaker">{message.role === 'assistant' ? 'Assistant' : 'You'}</span>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
            <div className="chat-prompts" aria-label="Suggested questions">
              {[
                'Summarize this patient’s record',
                'What are the latest vital signs?',
                'Which ABCDE entries are marked as a concern?',
                'What chart fields have no entry?',
              ].map((prompt) => (
                <button type="button" key={prompt} onClick={() => askQuestion(prompt)} disabled={!selected || loading}>
                  {prompt}
                </button>
              ))}
            </div>
            <form className="chat-form" onSubmit={submitQuestion}>
              <label className="sr-only" htmlFor="assistant-question">Ask about saved patient information</label>
              <input
                id="assistant-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={500}
                placeholder="Ask about saved observations, ABCDE, or the chart…"
                disabled={!selected || loading}
              />
              <button className="primary-btn" type="submit" disabled={!selected || loading || !question.trim()}>
                <Send /> Ask
              </button>
            </form>
            <p className="chat-footnote">Replies use fixed rules and saved chart data; they are not generated by a language model.</p>
            {latest && (
              <details className="handover-details">
                <summary>View structured handover</summary>
                <div className="handover-actions">
                  {summary.hasConcern && (
                    <div className="assist-concern"><AlertCircle /><span>Recorded ABCDE concern — review through your local escalation protocol.</span></div>
                  )}
                  <button className="outline-btn" type="button" onClick={() => void copySummary()} disabled={!summary.text}><Copy /> Copy handover</button>
                </div>
                <pre className="assist-summary">{summary.text}</pre>
                <small className="muted">Most recent record: {timeLabel(latest.created_at)} · Each field uses its latest recorded value.</small>
              </details>
            )}
          </section>
        </div>
      )}
      <div className="demo-disclaimer"><AlertCircle /> This is a deterministic demo feature, not a medical AI system. Do not rely on it for clinical decisions.</div>
    </>
  )
}

function Referrals({
  referrals,
  patients,
  onRefer,
  onUpdate,
}: {
  referrals: Referral[]
  patients: Patient[]
  onRefer: (patient: Patient) => void
  onUpdate: (referral: Referral, status: string) => void
}) {
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Specialty coordination</p><h2>Referrals</h2>
        <p className="muted">Track requests without changing staff-assigned triage acuity.</p></div></div>
      <section className="card referral-create">
        <div className="card-heading"><div><p className="eyebrow">New request</p><h3>Refer a patient</h3></div><FileText /></div>
        {patients.length === 0 ? <EmptyState message="No active patient records to refer." /> : (
          <div className="referral-patient-list">{patients.map((patient) => (
            <div className="referral-patient" key={patient.id}>
              <span><strong>{patient.name}</strong><small>{patient.external_id} · {patient.age} years · {acuityLabel(patient.acuity)}</small></span>
              <button className="outline-btn" onClick={() => onRefer(patient)}>Refer patient <ArrowUpRight /></button>
            </div>
          ))}</div>
        )}
      </section>
      <section className="card referral-list">
        <div className="card-heading"><div><p className="eyebrow">Referral history</p><h3>Requests and outcomes</h3></div><span className="tag">{referrals.length} referrals</span></div>
        {referrals.length === 0 ? <EmptyState message="No referrals have been requested." /> : referrals.map((referral) => (
          <article className="referral-row" key={referral.id}>
            <div className="referral-row-main">
              <div><strong>{referral.department}</strong><span className={`urgency ${referral.urgency.toLowerCase()}`}>{referral.urgency}</span></div>
              <p>{referral.reason}</p>
              <small>{referral.patient.name} · {referral.patient.external_id} · {timeLabel(referral.created_at)}</small>
            </div>
            <span className={`status ${referral.status.toLowerCase()}`}>{referral.status}</span>
            {referral.status === 'Requested' && <div className="referral-actions">
              <button className="outline-btn" onClick={() => onUpdate(referral, 'Accepted')}>Accept</button>
              <button className="text-btn" onClick={() => onUpdate(referral, 'Declined')}>Decline</button>
            </div>}
            {referral.status === 'Accepted' && <button className="outline-btn" onClick={() => onUpdate(referral, 'Completed')}>Mark completed</button>}
          </article>
        ))}
      </section>
      <div className="demo-disclaimer"><ShieldCheck /> Referral status is operational tracking only and never modifies triage priority.</div>
    </>
  )
}

function ReferralModal({
  patient,
  onClose,
  onSubmit,
}: {
  patient: Patient
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="referral-heading">
        <div className="modal-head"><div><p className="eyebrow">Referral request · {patient.external_id}</p><h2 id="referral-heading">{patient.name}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X /></button></div>
        <form onSubmit={onSubmit}>
          <label>Department<select name="department" defaultValue="Cardiology" required>
            {['Cardiology', 'Orthopaedics', 'Neurology', 'Surgery', 'Paediatrics', 'Radiology', 'ICU'].map((department) => <option key={department}>{department}</option>)}
          </select></label>
          <label>Urgency<select name="urgency" defaultValue="Routine" required>
            {['Routine', 'Urgent', 'Emergency'].map((urgency) => <option key={urgency}>{urgency}</option>)}
          </select></label>
          <label>Reason<textarea name="reason" minLength={2} maxLength={1000} placeholder="Reason for specialty referral" required /></label>
          <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-btn">Request referral <ArrowUpRight /></button></div>
        </form>
      </section>
    </div>
  )
}

function DischargeModal({
  patient,
  onClose,
  onSubmit,
}: {
  patient: Patient
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="discharge-heading">
        <div className="modal-head"><div><p className="eyebrow">Complete encounter</p><h2 id="discharge-heading">Discharge {patient.name}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X /></button></div>
        <form onSubmit={onSubmit}>
          <label>Outcome<input name="outcome" maxLength={500} placeholder="Encounter outcome" required /></label>
          <label>Advice<textarea name="advice" maxLength={1000} placeholder="Non-diagnostic follow-up advice" /></label>
          <div className="demo-disclaimer"><FileText /> Saving discharge opens the final report and CSV download.</div>
          <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-btn">Discharge & generate report <ArrowUpRight /></button></div>
        </form>
      </section>
    </div>
  )
}

type FinalReport = {
  patient_id: string
  name: string
  age: number
  arrival: string
  discharged_at: string | null
  triage_history: { acuity: Acuity; changed_at: string }[]
  wait_minutes: number
  referrals: { department: string; urgency: string; status: string; reason: string }[]
  resources_used: string[]
  outcome: string
  advice: string
}

const genericSms = 'Your hospital visit has ended. Please contact the hospital if you need assistance.'

function FinalReportModal({
  patient,
  onClose,
  onError,
  onSent,
}: {
  patient: Patient
  onClose: () => void
  onError: (message: string) => void
  onSent: () => void
}) {
  const [report, setReport] = useState<FinalReport | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    api<FinalReport>(`/api/patients/${patient.id}/final-report`)
      .then(setReport)
      .catch((error: unknown) => onError(errorMessage(error)))
  }, [patient.id, onError])

  const sendSms = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setSending(true)
    try {
      await api(`/api/patients/${patient.id}/sms`, {
        method: 'POST',
        body: JSON.stringify({
          phone: String(data.get('phone') ?? '').trim(),
          message: genericSms,
          consent: data.get('consent') === 'on',
        }),
      })
      onSent()
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setSending(false)
    }
  }

  const downloadCsv = async () => {
    try {
      await downloadFile(`/api/patients/${patient.id}/final-report.csv`, `final-report-${patient.external_id}.csv`)
    } catch (error) {
      onError(errorMessage(error))
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal report-modal" role="dialog" aria-modal="true" aria-labelledby="report-heading">
        <div className="modal-head"><div><p className="eyebrow">Discharge complete</p><h2 id="report-heading">Final report</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X /></button></div>
        {!report ? <p className="muted" aria-live="polite">Loading final report…</p> : (
          <>
            <div className="report-summary">
              <div><small>Patient</small><strong>{report.name} · {report.age} years</strong><span>{report.patient_id}</span></div>
              <div><small>Arrival</small><strong>{timeLabel(report.arrival)}</strong><span>Wait: {report.wait_minutes} minutes</span></div>
              <div><small>Outcome</small><strong>{report.outcome || 'Not recorded'}</strong><span>{report.advice || 'No advice recorded'}</span></div>
            </div>
            <div className="report-list"><strong>Triage history</strong>
              {report.triage_history.length ? report.triage_history.map((item, index) => (
                <span key={`${item.changed_at}-${index}`}>{acuityLabel(item.acuity)} · {timeLabel(item.changed_at)}</span>
              )) : <span>No triage history.</span>}
            </div>
            <div className="report-list"><strong>Referrals</strong>
              {report.referrals.length ? report.referrals.map((item, index) => (
                <span key={`${item.department}-${index}`}>{item.department} · {item.urgency} · {item.status} · {item.reason}</span>
              )) : <span>No referrals recorded.</span>}
            </div>
            <div className="report-list"><strong>Resources used</strong><span>{report.resources_used.join(', ') || 'None recorded'}</span></div>
            <button className="outline-btn" onClick={() => void downloadCsv()}><FileBarChart /> Download CSV</button>
          </>
        )}
        <form className="sms-form" onSubmit={sendSms}>
          <p className="eyebrow">Patient communication</p><h3>Send SMS</h3>
          <label>International phone number<input name="phone" type="tel" inputMode="tel" pattern="^\+[1-9][0-9]{7,14}$" placeholder="+919876543210" required /></label>
          <label>Message<textarea value={genericSms} maxLength={160} readOnly aria-describedby="sms-character-count" /></label>
          <small id="sms-character-count">{genericSms.length}/160 characters · No diagnosis details</small>
          <label className="consent-check"><input name="consent" type="checkbox" required /> Patient consent for this message is recorded.</label>
          <button className="primary-btn" type="submit" disabled={sending}>{sending ? 'Sending…' : 'Send SMS'}</button>
          <p className="card-note">Without Twilio credentials this saves to the demo SMS outbox; real delivery requires Twilio environment configuration.</p>
        </form>
        <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose}>Close report</button></div>
      </section>
    </div>
  )
}

function SmsOutbox({ entries }: { entries: SmsEntry[] }) {
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Message delivery history</p><h2>SMS outbox</h2>
        <p className="muted">Demo-mode messages are stored here. No keys are embedded in the application.</p></div><Mail /></div>
      <section className="card outbox-card">
        {entries.length === 0 ? <EmptyState message="No SMS messages have been recorded." /> : entries.map((entry) => (
          <article className="outbox-row" key={entry.id}>
            <div><strong>{entry.phone}</strong><small>Patient record #{entry.patient_id} · {timeLabel(entry.created_at)}</small><p>{entry.message}</p></div>
            <span className={`status ${entry.status.toLowerCase()}`}>{entry.status}</span>
          </article>
        ))}
      </section>
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
            <span key={acuity}><i className={`dot ${acuity.toLowerCase()}`} /> {acuityLabel(acuity)}
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
          <label>Triage category
            <select name="acuity" defaultValue="" required>
              <option value="" disabled>Select staff-assigned priority</option>
              <option value="Critical">Immediate · Red</option>
              <option value="Urgent">Delayed · Yellow</option>
              <option value="Standard">Standard · Green</option>
            </select>
          </label>
          <label>Initial notes<textarea name="notes" maxLength={2000} placeholder="Optional staff handover notes" /></label>
          <div className="demo-disclaimer"><AlertCircle /> Select acuity using your facility protocol. This prototype does not assign priority automatically.</div>
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
