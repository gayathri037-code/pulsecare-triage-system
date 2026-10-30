'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ambulance as AmbulanceIcon, MapPin, Navigation, RefreshCw, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import type { MapAmbulance } from './ambulance-map'

const AmbulanceMap = dynamic(() => import('./ambulance-map'), {
  ssr: false,
  loading: () => <div className="map-loading">Loading OpenStreetMap…</div>,
})

type AmbulanceRecord = MapAmbulance & {
  origin: string
  origin_lat: number
  origin_lng: number
  speed: number
  heading: number
  last_updated: string | null
  patient_id: number | null
}

type AmbulanceResponse = {
  hospital: { name: string; lat: number; lng: number }
  ambulances: AmbulanceRecord[]
}

function haversineKm(from: [number, number], to: [number, number]) {
  const radians = (value: number) => value * Math.PI / 180
  const [lat1, lng1] = from.map(radians)
  const [lat2, lng2] = to.map(radians)
  const dLat = lat2 - lat1
  const dLng = lng2 - lng1
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function headingBetween(from: [number, number], to: [number, number]) {
  const radians = (value: number) => value * Math.PI / 180
  const degrees = (value: number) => (value * 180 / Math.PI + 360) % 360
  const [lat1, lng1] = from.map(radians)
  const [lat2, lng2] = to.map(radians)
  return degrees(Math.atan2(
    Math.sin(lng2 - lng1) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1),
  ))
}

export default function AmbulanceDashboard({ onError }: { onError: (message: string) => void }) {
  const [response, setResponse] = useState<AmbulanceResponse>({ hospital: { name: 'Northstar General Hospital', lat: 13.0827, lng: 80.2707 }, ambulances: [] })
  const [routes, setRoutes] = useState<Record<string, [number, number][]>>({})
  const [simulating, setSimulating] = useState(false)
  const progress = useRef<Record<string, number>>({})
  const ambulancesRef = useRef<AmbulanceRecord[]>([])
  ambulancesRef.current = response.ambulances

  const refresh = useCallback(async () => {
    try {
      const current = await api<AmbulanceResponse>('/api/ambulances')
      setResponse(current)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unable to load ambulance locations.')
    }
  }, [onError])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const routeKey = useMemo(
    () => response.ambulances.map((item) => `${item.code}:${item.origin_lat},${item.origin_lng}:${item.destination_lat},${item.destination_lng}`).join('|'),
    [response.ambulances],
  )

  useEffect(() => {
    if (!routeKey) return
    let active = true
    const loadRoutes = async () => {
      const entries = await Promise.all(ambulancesRef.current.map(async (ambulance) => {
        try {
          const controller = new AbortController()
          const timeout = window.setTimeout(() => controller.abort(), 5000)
          let result: Response
          try {
            const url = `https://router.project-osrm.org/route/v1/driving/${ambulance.origin_lng},${ambulance.origin_lat};${ambulance.destination_lng},${ambulance.destination_lat}?overview=full&geometries=geojson`
            result = await fetch(url, { signal: controller.signal })
          } finally {
            window.clearTimeout(timeout)
          }
          if (!result.ok) throw new Error(`OSRM returned ${result.status}`)
          const data = await result.json() as { routes?: { geometry?: { coordinates?: [number, number][] } }[] }
          const coordinates = data.routes?.[0]?.geometry?.coordinates
          if (!coordinates?.length) throw new Error('OSRM route is empty')
          return [ambulance.code, coordinates.map(([lng, lat]) => [lat, lng] as [number, number])] as const
        } catch {
          return [ambulance.code, [
            [ambulance.origin_lat, ambulance.origin_lng],
            [ambulance.destination_lat, ambulance.destination_lng],
          ]] as const
        }
      }))
      const resolved = Object.fromEntries(entries)
      if (active) setRoutes(resolved)
    }
    void loadRoutes()
    return () => { active = false }
  }, [routeKey])

  const mapAmbulances = useMemo(() => response.ambulances.map((ambulance) => {
    const position: [number, number] = [
      ambulance.lat ?? ambulance.origin_lat,
      ambulance.lng ?? ambulance.origin_lng,
    ]
    const destination: [number, number] = [ambulance.destination_lat, ambulance.destination_lng]
    return {
      ...ambulance,
      route: routes[ambulance.code] ?? [[ambulance.origin_lat, ambulance.origin_lng], destination],
      eta_minutes: ambulance.speed > 1 ? Math.ceil(haversineKm(position, destination) / ambulance.speed * 60) : null,
    }
  }), [response.ambulances, routes])

  const sendSimulatorPing = useCallback(async (ambulance: AmbulanceRecord, route: [number, number][]) => {
    if (route.length < 2) return
    const currentIndex = progress.current[ambulance.code] ?? 0
    const nextIndex = (currentIndex + 1) % route.length
    progress.current[ambulance.code] = nextIndex
    const [lat, lng] = route[nextIndex]
    const previous = route[Math.max(0, nextIndex - 1)]
    await api(`/api/ambulances/${ambulance.code}/location`, {
      method: 'POST',
      body: JSON.stringify({
        lat,
        lng,
        speed: ambulance.code === 'AMB-01' ? 32 : ambulance.code === 'AMB-02' ? 28 : 35,
        heading: headingBetween(previous, [lat, lng]),
      }),
    })
  }, [])

  const toggleSimulator = () => {
    setSimulating((current) => !current)
  }

  useEffect(() => {
    if (!simulating || !ambulancesRef.current.length) return
    let sending = false
    const tick = async () => {
      if (sending) return
      sending = true
      try {
        await Promise.all(ambulancesRef.current.map((ambulance) =>
          sendSimulatorPing(ambulance, routes[ambulance.code] ?? [
            [ambulance.origin_lat, ambulance.origin_lng],
            [ambulance.destination_lat, ambulance.destination_lng],
          ]),
        ))
        await refresh()
      } catch (error) {
        onError(error instanceof Error ? error.message : 'The ambulance simulator could not send a GPS ping.')
      } finally {
        sending = false
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 3000)
    return () => window.clearInterval(timer)
  }, [simulating, routeKey, routes, sendSimulatorPing, refresh, onError])

  return (
    <>
      <div className="page-heading">
        <div><p className="eyebrow">Live fleet visibility</p><h2>Ambulances</h2>
          <p className="muted">Fictional response vehicles around Chennai · OpenStreetMap</p></div>
        <div className="ambulance-actions">
          <button className={simulating ? 'outline-btn' : 'primary-btn'} onClick={toggleSimulator}>
            <RefreshCw /> {simulating ? 'Stop demo simulator' : 'Start 3-second demo simulator'}
          </button>
        </div>
      </div>
      <div className="map-caption"><MapPin /> {response.hospital.name} · Chennai · {response.hospital.lat.toFixed(4)}, {response.hospital.lng.toFixed(4)}
        <span>OSRM driving route; straight-line route if unavailable</span></div>
      <section className="card map-card">
        <AmbulanceMap ambulances={mapAmbulances} hospital={[response.hospital.lat, response.hospital.lng]} />
      </section>
      <div className="ambulance-grid">
        {mapAmbulances.map((ambulance) => (
          <section className="card ambulance-card" key={ambulance.code}>
            <div className="ambulance-card-head">
              <span className="ambulance-symbol"><AmbulanceIcon /></span>
              <div><strong>{ambulance.code}</strong><small>{ambulance.direction}</small></div>
              <span className={ambulance.gps_lost ? 'gps-state lost' : 'gps-state live'}>
                {ambulance.gps_lost ? <><ShieldAlert /> GPS lost</> : <><span className="live-dot" /> Live</>}
              </span>
            </div>
            <p><MapPin /> {ambulance.origin} <span>→</span> {ambulance.destination}</p>
            <div className="ambulance-metrics">
              <span><b>{ambulance.eta_minutes === null ? '—' : `${ambulance.eta_minutes} min`}</b><small>{ambulance.direction === 'INBOUND' ? 'ETA to hospital' : 'ETA to destination'}</small></span>
              <span><b>{ambulance.speed.toFixed(0)} km/h</b><small>Current speed</small></span>
              <span><b>{ambulance.heading.toFixed(0)}°</b><small>Heading</small></span>
            </div>
            <small className="muted">{ambulance.last_updated ? `Last ping ${new Date(ambulance.last_updated).toLocaleTimeString()}` : 'Waiting for first GPS ping'}</small>
            <a className="driver-link" href={`/driver/${ambulance.code}`}><Navigation /> Open driver location page</a>
          </section>
        ))}
      </div>
      <div className="demo-disclaimer"><ShieldAlert /> GPS data and ambulance routes are fictional. GPS is marked lost if no location ping arrives for more than 30 seconds.</div>
    </>
  )
}
