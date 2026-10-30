'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { Ambulance, MapPin, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'

type Position = {
  latitude: number
  longitude: number
  speed: number | null
  heading: number | null
}

export default function DriverPage() {
  const params = useParams<{ ambulance: string }>()
  const code = String(params.ambulance ?? '').toUpperCase()
  const [sharing, setSharing] = useState(false)
  const [message, setMessage] = useState('Location sharing is off.')
  const [error, setError] = useState('')
  const latestPosition = useRef<Position | null>(null)
  const watchId = useRef<number | null>(null)
  const timerId = useRef<number | null>(null)

  const stopSharing = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
    if (timerId.current !== null) window.clearInterval(timerId.current)
    watchId.current = null
    timerId.current = null
    latestPosition.current = null
    setSharing(false)
  }, [])

  useEffect(() => () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
    if (timerId.current !== null) window.clearInterval(timerId.current)
  }, [])

  const startSharing = () => {
    setError('')
    if (!['AMB-01', 'AMB-02', 'AMB-03'].includes(code)) {
      setError('Unknown ambulance code. Use AMB-01, AMB-02, or AMB-03.')
      return
    }
    if (!navigator.geolocation) {
      setError('This browser does not support geolocation.')
      return
    }
    setSharing(true)
    setMessage('Waiting for a GPS fix…')
    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        latestPosition.current = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          speed: position.coords.speed,
          heading: position.coords.heading,
        }
      },
      (geoError) => {
        setError(`Location permission or GPS error: ${geoError.message}`)
        stopSharing()
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    )
    timerId.current = window.setInterval(() => {
      const current = latestPosition.current
      if (!current) return
      void api(`/api/ambulances/${code}/location`, {
        method: 'POST',
        body: JSON.stringify({
          lat: current.latitude,
          lng: current.longitude,
          speed: current.speed === null ? 0 : current.speed * 3.6,
          heading: current.heading === null ? 0 : current.heading,
        }),
      }).then(() => {
        setError('')
        setMessage(`Last GPS ping sent at ${new Date().toLocaleTimeString()}.`)
      }).catch((sendError: unknown) => {
        setError(sendError instanceof Error ? sendError.message : 'The GPS ping could not be sent.')
        stopSharing()
      })
    }, 3000)
  }

  return (
    <main className="driver-page">
      <section className="driver-card">
        <div className="brand-mark"><Ambulance /></div>
        <p className="eyebrow">PulseCare fleet location</p>
        <h1>Share {code || 'ambulance'} location</h1>
        <p className="muted">Keep this page open while on duty. Location is sent to the signed-in PulseCare demo every 3 seconds.</p>
        <div className="driver-status"><MapPin /><span>{message}</span></div>
        {error && <div className="inline-error" role="alert"><ShieldAlert /> {error}</div>}
        {!sharing ? (
          <button className="primary-btn full" onClick={startSharing}>Start sharing location</button>
        ) : (
          <button className="outline-btn full" onClick={stopSharing}>Stop sharing location</button>
        )}
        <small>Location sharing requires browser permission and HTTPS or localhost. This demo uses fictional routes, but device GPS reports the real device location.</small>
        <a href="/" className="driver-back">Return to PulseCare</a>
      </section>
    </main>
  )
}
