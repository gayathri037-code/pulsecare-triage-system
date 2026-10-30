'use client'

import { Fragment, useEffect, useRef } from 'react'
import L from 'leaflet'
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'

export type MapAmbulance = {
  code: string
  direction: 'INBOUND' | 'OUTBOUND'
  origin_lat: number
  origin_lng: number
  destination: string
  destination_lat: number
  destination_lng: number
  lat: number | null
  lng: number | null
  trail: { lat: number; lng: number }[]
  route: [number, number][]
  gps_lost: boolean
  eta_minutes: number | null
}

function icon(label: string, variant: 'ambulance' | 'destination') {
  return L.divIcon({
    className: 'map-marker-wrapper',
    html: `<span class="map-marker ${variant}">${label}</span>`,
    iconSize: [42, 34],
    iconAnchor: [21, 17],
  })
}

function FitMap({ ambulances, hospital }: { ambulances: MapAmbulance[]; hospital: [number, number] }) {
  const map = useMap()
  const fitted = useRef(false)

  useEffect(() => {
    if (fitted.current) return
    const points: [number, number][] = [hospital]
    for (const ambulance of ambulances) {
      points.push([ambulance.destination_lat, ambulance.destination_lng])
      points.push([ambulance.origin_lat, ambulance.origin_lng])
      if (ambulance.lat !== null && ambulance.lng !== null) points.push([ambulance.lat, ambulance.lng])
    }
    if (points.length > 1) {
      map.fitBounds(points, { padding: [32, 32], maxZoom: 14 })
      fitted.current = true
    }
  }, [ambulances, hospital, map])

  return null
}

export default function AmbulanceMap({
  ambulances,
  hospital,
}: {
  ambulances: MapAmbulance[]
  hospital: [number, number]
}) {
  return (
    <MapContainer center={hospital} zoom={12} scrollWheelZoom className="ambulance-map">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitMap ambulances={ambulances} hospital={hospital} />
      <Marker position={hospital} icon={icon('H', 'destination')}>
        <Popup>Northstar General Hospital · Chennai</Popup>
      </Marker>
      {ambulances.map((ambulance) => (
        <Fragment key={ambulance.code}>
          <Polyline
            positions={ambulance.route.length ? ambulance.route : [
              [ambulance.destination_lat, ambulance.destination_lng],
              [ambulance.lat ?? hospital[0], ambulance.lng ?? hospital[1]],
            ]}
            pathOptions={{ color: ambulance.direction === 'INBOUND' ? '#25896f' : '#557dc3', weight: 4, opacity: 0.62, dashArray: '9 8' }}
          />
          {ambulance.trail.length > 1 && (
            <Polyline
              positions={ambulance.trail.map((point) => [point.lat, point.lng] as [number, number])}
              pathOptions={{ color: '#e57d36', weight: 4, opacity: 0.9 }}
            />
          )}
          {ambulance.lat !== null && ambulance.lng !== null && (
            <Marker position={[ambulance.lat, ambulance.lng]} icon={icon(ambulance.code.slice(-2), 'ambulance')}>
              <Popup>
                <strong>{ambulance.code}</strong><br />
                {ambulance.direction} · {ambulance.gps_lost ? 'GPS lost' : `${ambulance.eta_minutes ?? '—'} min ETA`}
              </Popup>
            </Marker>
          )}
          {ambulance.trail.length === 0 && (
            <Marker position={[ambulance.origin_lat, ambulance.origin_lng]} icon={icon(ambulance.code.slice(-2), 'ambulance')}>
              <Popup>{ambulance.code} · {ambulance.gps_lost ? 'GPS lost · no position received' : 'Waiting for first GPS ping'}</Popup>
            </Marker>
          )}
        </Fragment>
      ))}
    </MapContainer>
  )
}
