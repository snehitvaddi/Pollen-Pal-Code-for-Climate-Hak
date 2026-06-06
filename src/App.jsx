import { CircleF, GoogleMap, MarkerF, PolylineF, useJsApiLoader } from '@react-google-maps/api'
import { Capacitor, registerPlugin } from '@capacitor/core'
import {
  AlertTriangle,
  Bike,
  Clock,
  Glasses,
  Loader2,
  LocateFixed,
  MapPin,
  Navigation,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trees,
  Wind,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const PollenPalGlasses = registerPlugin('PollenPalGlasses')
const DEFAULT_CENTER = { lat: 40.758, lng: -73.9855 }
const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
const GOOGLE_POLLEN_BROWSER_KEY = import.meta.env.VITE_GOOGLE_POLLEN_API_KEY || GOOGLE_MAPS_KEY
const MAP_LIBRARIES = ['places']
const REFRESH_INTERVAL_MS = 10 * 60 * 1000
const LIVE_REFRESH_MS = 60 * 1000
const HOTSPOT_SAMPLE_COUNT = 18
const HOTSPOT_ENTRY_METERS = 85
const HOTSPOT_PREVIEW_MIN_METERS = 80
const HOTSPOT_PREVIEW_MAX_METERS = 380
const SAFE_MESSAGE_COOLDOWN_MS = 2 * 60 * 1000
const ALERT_COOLDOWN_MS = 45 * 1000
const DEMO_SPEAKER_PAUSE_MS = 4200

const sensitivityBoost = {
  low: 0.85,
  medium: 1,
  high: 1.2,
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function readableError(value, fallback = 'Something went wrong') {
  if (!value) return fallback
  if (typeof value === 'string') return value
  if (value.message) return value.message
  if (value.error) return readableError(value.error, fallback)
  try {
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function pointToLatLng(point) {
  return {
    lat: typeof point.lat === 'function' ? point.lat() : point.lat,
    lng: typeof point.lng === 'function' ? point.lng() : point.lng,
  }
}

function samplePath(path, count = 5) {
  if (!path?.length) return []
  if (path.length <= count) return path.map(pointToLatLng)

  return Array.from({ length: count }, (_, index) => {
    const pathIndex = Math.round((index * (path.length - 1)) / (count - 1))
    return pointToLatLng(path[pathIndex])
  })
}

function getPollenSummary(pollen) {
  const day = pollen?.dailyInfo?.[0]
  const types = day?.pollenTypeInfo || []
  const plants = day?.plantInfo || []
  const values = types
    .map((type) => ({
      code: type.code,
      name: type.displayName || type.code,
      value: type.indexInfo?.value ?? 0,
      category: type.indexInfo?.category || 'None',
      inSeason: Boolean(type.inSeason),
      recommendation: type.healthRecommendations?.[0],
    }))
    .sort((a, b) => b.value - a.value)

  return {
    max: values[0]?.value ?? 0,
    dominant: values[0],
    date: day?.date,
    unavailable: Boolean(pollen?.unavailable),
    error: pollen?.error,
    types: values,
    plants: plants
      .filter((plant) => plant.indexInfo?.value)
      .sort((a, b) => (b.indexInfo?.value || 0) - (a.indexInfo?.value || 0))
      .slice(0, 4)
      .map((plant) => ({
        name: plant.displayName || plant.code,
        value: plant.indexInfo?.value || 0,
        season: plant.plantDescription?.season,
        family: plant.plantDescription?.family,
        crossReaction: plant.plantDescription?.crossReaction,
      })),
  }
}

function fallbackPollen(point, error) {
  return {
    unavailable: true,
    point,
    error: readableError(error, 'Pollen data unavailable for this location'),
    dailyInfo: [
      {
        date: null,
        pollenTypeInfo: [
          {
            code: 'POLLEN',
            displayName: 'Pollen unavailable',
            indexInfo: { value: 0, category: 'Unavailable' },
          },
        ],
        plantInfo: [],
      },
    ],
  }
}

function formatPollenDate(date) {
  if (!date?.year || !date?.month || !date?.day) return 'Unavailable'
  return new Date(date.year, date.month - 1, date.day).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function distanceMeters(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY
  const earthRadius = 6371000
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180
  const h =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2)
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function stripHtml(value) {
  if (!value) return ''
  const container = document.createElement('div')
  container.innerHTML = value
  return container.textContent || container.innerText || ''
}

function midpoint(a, b) {
  return {
    lat: (a.lat + b.lat) / 2,
    lng: (a.lng + b.lng) / 2,
  }
}

function pathDistanceMeters(path) {
  if (!path?.length) return 0
  return path.slice(0, -1).reduce((sum, point, index) => sum + distanceMeters(point, path[index + 1]), 0)
}

function interpolatePoint(a, b, ratio) {
  return {
    lat: a.lat + (b.lat - a.lat) * ratio,
    lng: a.lng + (b.lng - a.lng) * ratio,
  }
}

function splitPathBeforeEnd(path, metersBeforeEnd = 220) {
  const points = path.map(pointToLatLng)
  if (points.length < 2) {
    return { pathToPoint: points, pathFromPoint: points, point: points[0] || DEFAULT_CENTER }
  }

  let remaining = metersBeforeEnd
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const start = points[index]
    const end = points[index + 1]
    const segmentDistance = distanceMeters(start, end)

    if (segmentDistance >= remaining) {
      const point = interpolatePoint(end, start, remaining / segmentDistance)
      return {
        pathToPoint: [...points.slice(0, index + 1), point],
        pathFromPoint: [point, ...points.slice(index + 1)],
        point,
      }
    }

    remaining -= segmentDistance
  }

  return { pathToPoint: [points[0]], pathFromPoint: points, point: points[0] }
}

function getRouteDisplaySegments(route, mode) {
  if (!route?.overview_path?.length) return []
  if (route.displaySegments?.length) return route.displaySegments

  const split = splitPathBeforeEnd(route.overview_path, mode === 'WALKING' ? 120 : 220)
  return [
    {
      id: 'walk-main',
      mode: 'walk',
      path: split.pathToPoint,
      emphasis: 'main',
    },
    {
      id: 'walk-final',
      mode: 'walk',
      path: split.pathFromPoint,
      emphasis: 'final',
    },
  ]
}

function metersText(value) {
  if (value >= 1609.34) return `${(value / 1609.34).toFixed(1)} mi`
  return `${Math.round(value)} m`
}

function secondsText(value) {
  const minutes = Math.max(1, Math.round(value / 60))
  return `${minutes} min`
}

function getRiskColor(score) {
  if (score >= 76) return '#dc2626'
  if (score >= 56) return '#f97316'
  if (score >= 34) return '#facc15'
  return '#22c55e'
}

function weatherMultiplier(weather) {
  const wind = weather?.current?.wind_speed_10m || 0
  const gust = weather?.current?.wind_gusts_10m || 0
  const rain = weather?.current?.precipitation || 0
  const humidity = weather?.current?.relative_humidity_2m || 0

  let multiplier = 1
  if (wind >= 15) multiplier += 0.28
  else if (wind >= 9) multiplier += 0.16

  if (gust >= 24) multiplier += 0.18
  if (humidity >= 75) multiplier -= 0.08
  if (rain > 0) multiplier -= 0.22

  return Math.max(0.65, multiplier)
}

function riskLabel(score) {
  if (score >= 84) return { label: 'Very High', tone: 'danger' }
  if (score >= 64) return { label: 'High', tone: 'warning' }
  if (score >= 42) return { label: 'Moderate', tone: 'notice' }
  return { label: 'Lower', tone: 'calm' }
}

function scoreExposurePoint(summary, weather, sensitivity, mode, durationMinutes, greenerySample = { count: 0 }) {
  const pollenValue = summary.max || 0
  const wind = weather?.current?.wind_speed_10m || 0
  const gust = weather?.current?.wind_gusts_10m || 0
  const rain = weather?.current?.precipitation || 0
  const humidity = weather?.current?.relative_humidity_2m || 0
  const parkCount = greenerySample.count || 0

  const windBoost = wind >= 18 ? 0.18 : wind >= 12 ? 0.1 : wind >= 7 ? 0.04 : 0
  const gustBoost = gust >= 28 ? 0.1 : gust >= 20 ? 0.05 : 0
  const parkWindAlignmentBoost = parkCount > 0 && wind >= 12 ? 0.05 : 0
  const activeRainReduction = rain > 0 ? 0.24 : 0
  const humidityFragmentationBoost = humidity >= 80 ? 0.05 : humidity >= 70 ? 0.025 : 0
  const parkProximityBoost = Math.min(parkCount, 5) * 0.025
  const routeExposureDurationBoost = Math.min(durationMinutes / (mode === 'BICYCLING' ? 90 : 75), 1) * 0.08

  const weatherFactor =
    1 + windBoost + gustBoost + parkWindAlignmentBoost - activeRainReduction + humidityFragmentationBoost
  const environmentFactor = 1 + parkProximityBoost + routeExposureDurationBoost
  const score = Math.round(
    clamp((pollenValue / 5) * 58 * weatherFactor * environmentFactor * sensitivityBoost[sensitivity], 0, 100),
  )

  const factors = []
  if (summary.dominant?.name) factors.push(`${summary.dominant.name} pollen`)
  if (windBoost > 0) factors.push('wind spread')
  if (gustBoost > 0) factors.push('gusts')
  if (parkProximityBoost > 0) factors.push('park proximity')
  if (rain > 0) factors.push('active rain reduction')
  if (humidityFragmentationBoost > 0) factors.push('humid air fragmentation')

  return {
    score,
    label: riskLabel(score),
    dominantPollen: summary.dominant?.name || 'Pollen',
    pollenValue,
    windSpeed: wind,
    windDirection: weather?.current?.wind_direction_10m || 0,
    precipitation: rain,
    humidity,
    parkCount,
    factors,
  }
}

function buildHotspotSegments(route, pollenResults, weather, sensitivity, mode, greenerySamples) {
  const routePoints = samplePath(route.overview_path, HOTSPOT_SAMPLE_COUNT)
  const durationMinutes = (route.legs?.[0]?.duration?.value || 0) / 60
  const hotspotPoints = routePoints.map((point, index) => ({
    ...point,
    ...scoreExposurePoint(getPollenSummary(pollenResults[index]), weather, sensitivity, mode, durationMinutes, greenerySamples[index]),
  }))

  const rawSegments = hotspotPoints.slice(0, -1).map((point, index) => {
    const nextPoint = hotspotPoints[index + 1]
    const score = Math.round((point.score + nextPoint.score) / 2)
    return {
      id: `${point.lat}-${point.lng}-${index}`,
      path: [
        { lat: point.lat, lng: point.lng },
        { lat: nextPoint.lat, lng: nextPoint.lng },
      ],
      midpoint: midpoint(point, nextPoint),
      score,
      label: riskLabel(score),
      dominantPollen: point.dominantPollen,
      factors: Array.from(new Set([...point.factors, ...nextPoint.factors])).slice(0, 4),
    }
  })

  const minScore = Math.min(...rawSegments.map((segment) => segment.score))
  const maxScore = Math.max(...rawSegments.map((segment) => segment.score))
  const spread = Math.max(maxScore - minScore, 1)

  return rawSegments.map((segment) => {
    const visualScore = spread < 10 ? segment.score : Math.round(((segment.score - minScore) / spread) * 70 + 20)
    return {
      ...segment,
      visualScore,
      color: getRiskColor(visualScore),
    }
  })
}

function scoreRoute(route, pollenResults, weather, sensitivity, mode, greenerySamples, hotspotSegments) {
  const pollenSummaries = pollenResults.map(getPollenSummary)
  const pollenUnavailable = pollenSummaries.some((summary) => summary.unavailable)
  const averagePollen =
    pollenSummaries.reduce((sum, summary) => sum + summary.max, 0) / Math.max(pollenSummaries.length, 1)
  const distanceMiles = (route.legs?.[0]?.distance?.value || 0) / 1609.34
  const durationMinutes = (route.legs?.[0]?.duration?.value || 0) / 60
  const outdoorLoad = mode === 'BICYCLING' ? durationMinutes * 0.82 : durationMinutes
  const dominant = pollenSummaries
    .flatMap((summary) => summary.types)
    .reduce((best, current) => (current.value > (best?.value || 0) ? current : best), null)
  const greeneryScore =
    greenerySamples.reduce((sum, sample) => sum + Math.min(sample.count, 3), 0) / Math.max(greenerySamples.length, 1)

  const raw =
    ((averagePollen / 5) * 52 +
      Math.min(outdoorLoad / 80, 1) * 8 +
      Math.min(distanceMiles / 5, 1) * 4 +
      greeneryScore * 1.2) *
    weatherMultiplier(weather) *
    sensitivityBoost[sensitivity]

  const hotspotAverage =
    hotspotSegments.reduce((sum, segment) => sum + segment.score, 0) / Math.max(hotspotSegments.length, 1)
  const score = Math.min(100, Math.round(hotspotAverage * 0.7 + raw * 0.3))
  const label = riskLabel(score)

  return {
    score,
    label,
    dominant,
    distanceMiles,
    durationMinutes,
    mixedMode: Boolean(route.mixedMode),
    walkFinishMeters: route.walkFinishMeters || 0,
    pollenSummaries,
    pollenUnavailable,
    greenerySamples,
    greeneryScore,
    hotspotSegments,
  }
}

function buildAdvice(result, weather, mode) {
  if (!result) return []
  if (result.pollenUnavailable) {
    return [
      'Google Pollen data is unavailable for this route, so Pollen Pal can only show weather and park context here.',
      'Use this as a routing demo location issue, not as a low-risk pollen result.',
    ]
  }
  const wind = weather?.current?.wind_speed_10m
  const dominant = result.dominant?.name || 'pollen'
  const modeLabel = mode === 'BICYCLING' ? 'ride' : 'walk'

  const advice = []
  if (result.score >= 64) {
    advice.push(`Avoid this ${modeLabel} if you can; ${dominant.toLowerCase()} exposure is elevated along the route.`)
    advice.push('Wear wraparound glasses or a mask, and keep medication accessible.')
  } else if (result.score >= 42) {
    advice.push(`This ${modeLabel} is manageable, but expect symptoms if you are sensitive to ${dominant.toLowerCase()}.`)
    advice.push('Choose the shortest lower-tree segment and rinse face/hair after arriving.')
  } else {
    advice.push(`This is the lowest-risk ${modeLabel} among the options right now.`)
    advice.push('Still carry backup medication if pollen has triggered symptoms recently.')
  }

  if (wind >= 12) {
    advice.push(`Wind is ${Math.round(wind)} mph, so pollen can spread beyond the exact source area.`)
  }

  if (mode === 'BICYCLING' && result.mixedMode) {
    advice.push(`Bike mode includes a short ${metersText(result.walkFinishMeters)} final walk, so Pollen Pal still checks exposure near the parking/dismount point.`)
  }

  return advice
}

async function fetchPollen(point) {
  const shouldUseDirectGoogleRequest =
    window.location.protocol === 'capacitor:' || window.location.protocol === 'file:' || import.meta.env.PROD
  const url = shouldUseDirectGoogleRequest
    ? new URL('https://pollen.googleapis.com/v1/forecast:lookup')
    : new URL(`/api/pollen?lat=${point.lat}&lng=${point.lng}&days=1`, window.location.origin)

  if (shouldUseDirectGoogleRequest) {
    url.searchParams.set('key', GOOGLE_POLLEN_BROWSER_KEY)
    url.searchParams.set('location.latitude', point.lat)
    url.searchParams.set('location.longitude', point.lng)
    url.searchParams.set('days', '1')
    url.searchParams.set('plantsDescription', 'true')
  }

  const response = await fetch(url)
  const data = await response.json()
  if (!response.ok) {
    throw new Error(readableError(data, 'Google Pollen request failed'))
  }
  return data
}

async function fetchWeather(point) {
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', point.lat)
  url.searchParams.set('longitude', point.lng)
  url.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
  )
  url.searchParams.set('temperature_unit', 'fahrenheit')
  url.searchParams.set('wind_speed_unit', 'mph')
  url.searchParams.set('timezone', 'auto')

  const response = await fetch(url)
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.reason || 'Open-Meteo request failed')
  }
  return data
}

async function fetchGreenerySamples(map, samplePoints) {
  if (!map || !window.google?.maps?.places?.PlacesService) {
    return samplePoints.map((point) => ({ ...point, count: 0, names: [] }))
  }

  const service = new window.google.maps.places.PlacesService(map)

  const results = await Promise.all(
    samplePoints.map(
      (point) =>
        new Promise((resolve) => {
          service.nearbySearch(
            {
              location: point,
              radius: 300,
              type: 'park',
            },
            (places, status) => {
              if (status !== window.google.maps.places.PlacesServiceStatus.OK || !places) {
                resolve({ ...point, count: 0, names: [] })
                return
              }

              resolve({
                ...point,
                count: Math.min(places.length, 5),
                names: places.slice(0, 3).map((place) => place.name),
              })
            },
          )
        }),
    ),
  )

  return samplePoints.map((point, index) => results[index] || { ...point, count: 0, names: [] })
}

async function buildBikeWalkDirections(service, baseResponse, destination) {
  const mixedRoutes = await Promise.all(
    baseResponse.routes.slice(0, 3).map(async (bikeRoute) => {
      const bikePath = bikeRoute.overview_path.map(pointToLatLng)
      const split = splitPathBeforeEnd(bikePath, 220)
      const walkingResponse = await service.route({
        origin: split.point,
        destination,
        travelMode: window.google.maps.TravelMode.WALKING,
        provideRouteAlternatives: false,
      })
      const walkingRoute = walkingResponse.routes[0]
      const walkingLeg = walkingRoute.legs[0]
      const walkingPath = walkingRoute.overview_path.map(pointToLatLng)
      const combinedPath = [...split.pathToPoint, ...walkingPath.slice(1)]
      const bikeDistance = pathDistanceMeters(split.pathToPoint)
      const walkDistance = walkingLeg.distance?.value || pathDistanceMeters(walkingPath)
      const bikeTotalDistance = pathDistanceMeters(bikePath) || bikeRoute.legs?.[0]?.distance?.value || bikeDistance
      const bikeTotalDuration = bikeRoute.legs?.[0]?.duration?.value || 0
      const bikeDuration = bikeTotalDuration ? bikeTotalDuration * (bikeDistance / Math.max(bikeTotalDistance, 1)) : 0
      const totalDistance = bikeDistance + walkDistance
      const totalDuration = bikeDuration + (walkingLeg.duration?.value || 0)

      return {
        ...bikeRoute,
        summary: `${bikeRoute.summary || 'Bike route'} + walk finish`,
        overview_path: combinedPath,
        mixedMode: true,
        dismountPoint: split.point,
        walkFinishMeters: walkDistance,
        displaySegments: [
          {
            id: 'bike-leg',
            mode: 'bike',
            path: split.pathToPoint,
            emphasis: 'main',
          },
          {
            id: 'walk-finish',
            mode: 'walk',
            path: walkingPath,
            emphasis: 'final',
          },
        ],
        legs: [
          {
            ...bikeRoute.legs[0],
            distance: { text: metersText(totalDistance), value: totalDistance },
            duration: { text: secondsText(totalDuration), value: totalDuration },
            end_address: walkingLeg.end_address,
            end_location: walkingLeg.end_location,
            steps: [...(bikeRoute.legs[0]?.steps || []), ...(walkingLeg.steps || [])],
          },
        ],
      }
    }),
  )

  return {
    ...baseResponse,
    routes: mixedRoutes,
  }
}

function findNearestHotspot(point, segments) {
  if (!point || !segments?.length) return null
  return segments.reduce(
    (nearest, segment) => {
      const distance = distanceMeters(point, segment.midpoint)
      return distance < nearest.distance ? { ...segment, distance } : nearest
    },
    { distance: Number.POSITIVE_INFINITY },
  )
}

function findNearestRoutePoint(point, routePath) {
  if (!point || !routePath?.length) return { point, distance: Number.POSITIVE_INFINITY }
  return routePath.reduce(
    (nearest, routePoint, index) => {
      const distance = distanceMeters(point, routePoint)
      return distance < nearest.distance ? { point: routePoint, distance, index } : nearest
    },
    { point: routePath[0], distance: Number.POSITIVE_INFINITY, index: 0 },
  )
}

function distanceAlongRoute(routePath, startIndex, endIndex) {
  if (!routePath?.length || startIndex === endIndex) return 0
  const start = clamp(Math.min(startIndex, endIndex), 0, routePath.length - 1)
  const end = clamp(Math.max(startIndex, endIndex), 0, routePath.length - 1)
  let total = 0
  for (let index = start; index < end; index += 1) {
    total += distanceMeters(routePath[index], routePath[index + 1])
  }
  return total
}

function findUpcomingHotspot(point, routePath, segments) {
  if (!point || !routePath?.length || !segments?.length) return null
  const current = findNearestRoutePoint(point, routePath)
  return segments
    .filter((segment) => segment.score >= 64)
    .map((segment) => {
      const target = findNearestRoutePoint(segment.midpoint, routePath)
      const metersAway = target.index >= current.index ? distanceAlongRoute(routePath, current.index, target.index) : -1
      return {
        ...segment,
        metersAway,
        routeIndex: target.index,
      }
    })
    .filter((segment) => segment.metersAway >= 0)
    .sort((a, b) => a.metersAway - b.metersAway)[0]
}

function findCurrentStep(point, directions, selectedRoute) {
  const steps = directions?.routes?.[selectedRoute]?.legs?.[0]?.steps || []
  if (!point || !steps.length) return null

  const nearest = steps.reduce(
    (best, step, index) => {
      const start = pointToLatLng(step.start_location)
      const end = pointToLatLng(step.end_location)
      const distanceToEnd = distanceMeters(point, end)
      const distanceToStart = distanceMeters(point, start)
      const distance = Math.min(distanceToStart, distanceToEnd)
      return distance < best.distance ? { step, index, distance, distanceToEnd } : best
    },
    { distance: Number.POSITIVE_INFINITY },
  )

  return {
    index: nearest.index,
    instruction: stripHtml(nearest.step.instructions),
    distanceToNextStep: nearest.distanceToEnd,
    endPoint: pointToLatLng(nearest.step.end_location),
    travelMode: nearest.step.travel_mode,
  }
}

function MissingKeyApp() {
  return (
    <main className="app-shell setup-only">
      <section className="control-panel" aria-label="Pollen Pal setup">
        <div className="brand-row">
          <div className="brand-mark">
            <Trees size={22} />
          </div>
          <div>
            <p className="eyebrow">Code for Climate / Protect</p>
            <h1>Pollen Pal</h1>
          </div>
        </div>

        <div className="error-box">
          <AlertTriangle size={18} />
          <span>Missing VITE_GOOGLE_MAPS_API_KEY. Create `.env.local`, add your keys, then restart `npm run dev`.</span>
        </div>

        <div className="advice">
          <h2>Fill this in now</h2>
          <p>VITE_GOOGLE_MAPS_API_KEY=your browser-restricted Google Maps key</p>
          <p>GOOGLE_POLLEN_API_KEY=your Google Pollen API key</p>
        </div>
      </section>
    </main>
  )
}

function PollenPalApp() {
  const [origin, setOrigin] = useState('515 Madison Ave, New York, NY')
  const [destination, setDestination] = useState('Bryant Park, New York, NY')
  const [mode, setMode] = useState('WALKING')
  const [sensitivity, setSensitivity] = useState('high')
  const [directions, setDirections] = useState(null)
  const [selectedRoute, setSelectedRoute] = useState(0)
  const [results, setResults] = useState([])
  const [weather, setWeather] = useState(null)
  const [showWindLayer, setShowWindLayer] = useState(true)
  const [showGreenLayer, setShowGreenLayer] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isTracking, setIsTracking] = useState(false)
  const [isFollowMode, setIsFollowMode] = useState(false)
  const [currentLocation, setCurrentLocation] = useState(null)
  const [gpsRouteWarning, setGpsRouteWarning] = useState('')
  const [liveStatus, setLiveStatus] = useState(null)
  const [glassesStatus, setGlassesStatus] = useState({ available: false, connected: false, likelyMetaGlasses: false })
  const [glassesWearConfirmed, setGlassesWearConfirmed] = useState(false)
  const [glassesDemoMessage, setGlassesDemoMessage] = useState('')
  const [isDemoSpeaking, setIsDemoSpeaking] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const mapRef = useRef(null)
  const locationWatchRef = useRef(null)
  const liveRefreshRef = useRef(null)
  const lastLiveCheckRef = useRef(null)
  const lastSpokenAlertRef = useRef({ key: '', time: 0, wasHighRisk: false, lastSafeAt: 0 })
  const followModeRef = useRef(false)
  const pollenCacheRef = useRef(new Map())

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: GOOGLE_MAPS_KEY,
    libraries: MAP_LIBRARIES,
  })

  const selectedResult = results[selectedRoute]
  const advice = useMemo(() => buildAdvice(selectedResult, weather, mode), [selectedResult, weather, mode])
  const selectedRoutePath = useMemo(
    () => directions?.routes?.[selectedRoute]?.overview_path?.map(pointToLatLng) || [],
    [directions, selectedRoute],
  )
  const selectedLeg = directions?.routes?.[selectedRoute]?.legs?.[0]
  const routeStart = selectedLeg?.start_location ? pointToLatLng(selectedLeg.start_location) : selectedRoutePath[0]
  const routeEnd = selectedLeg?.end_location
    ? pointToLatLng(selectedLeg.end_location)
    : selectedRoutePath[selectedRoutePath.length - 1]
  const selectedRouteDisplaySegments = useMemo(
    () => getRouteDisplaySegments(directions?.routes?.[selectedRoute], mode),
    [directions, selectedRoute, mode],
  )

  async function fetchCachedPollen(point) {
    const key = `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`
    if (!pollenCacheRef.current.has(key)) {
      pollenCacheRef.current.set(key, fetchPollen(point).catch((error) => fallbackPollen(point, error)))
    }
    return pollenCacheRef.current.get(key)
  }

  useEffect(() => {
    if (!directions || !results.length) return undefined

    const timer = window.setInterval(() => {
      analyzeRoute(null, { silent: true })
    }, REFRESH_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [directions, results.length, origin, destination, mode, sensitivity])

  useEffect(
    () => () => {
      if (locationWatchRef.current) navigator.geolocation.clearWatch(locationWatchRef.current)
      if (liveRefreshRef.current) window.clearInterval(liveRefreshRef.current)
    },
    [],
  )

  useEffect(() => {
    if (!selectedResult) return undefined
    checkGlassesStatus()
    const timer = window.setInterval(checkGlassesStatus, 15_000)
    return () => window.clearInterval(timer)
  }, [selectedResult])

  useEffect(() => {
    if (!selectedResult) return
    const routeLabel = selectedResult.label?.label?.toLowerCase() || 'route'
    speakGlassesAlert(`Pollen Pal is connected. This route has ${routeLabel} pollen exposure. Start walking when ready.`, `route-ready:${selectedRoute}:${selectedResult.score}`)
  }, [selectedResult, selectedRoute])

  async function checkGlassesStatus() {
    if (!Capacitor.isNativePlatform()) {
      setGlassesStatus({ available: false, connected: false, likelyMetaGlasses: false, routeName: 'Browser preview' })
      return null
    }

    try {
      const statusResult = await PollenPalGlasses.getStatus()
      setGlassesStatus(statusResult)
      return statusResult
    } catch {
      const unavailable = { available: false, connected: false, likelyMetaGlasses: false, routeName: 'iOS audio unavailable' }
      setGlassesStatus(unavailable)
      return unavailable
    }
  }

  async function speakGlassesAlert(message, key, options = {}) {
    if (!message || !Capacitor.isNativePlatform()) return

    const now = Date.now()
    const last = lastSpokenAlertRef.current
    const alertKey = key || message
    if (last.key === alertKey && now - last.time < ALERT_COOLDOWN_MS) return

    const currentStatus = await checkGlassesStatus()
    if (!currentStatus?.connected && !options.force) return

    lastSpokenAlertRef.current = {
      ...last,
      key: alertKey,
      time: now,
    }

    try {
      await PollenPalGlasses.speak({
        text: message,
        rate: 0.47,
        pitch: 1.02,
        volume: 0.96,
      })
    } catch (speechError) {
      setError(readableError(speechError, 'Unable to speak through the connected audio route'))
    }
  }

  async function testGlassesAudio() {
    if (!Capacitor.isNativePlatform()) {
      setError('Glasses audio test only runs in the iOS app. Browser preview stays quiet.')
      return
    }

    const currentStatus = await checkGlassesStatus()
    if (!currentStatus?.connected) {
      setGlassesDemoMessage(
        'iOS has not confirmed the glasses route. Playing test audio anyway; if Control Center output is set to Ray-Ban Meta, you should hear it there.',
      )
    }

    await speakGlassesAlert(
      'Pollen Pal audio test. I will warn you before higher pollen segments and give you breathing time in safer areas.',
      `manual-test:${Date.now()}`,
      { force: true },
    )
  }

  async function runMetaGlassesDemo() {
    const demoMessages = [
      'Pollen Pal route guidance started. Keep your Meta glasses on and I will keep alerts short.',
      'In about three minutes, you will enter a higher grass pollen zone near a park edge. Please wear a mask or cover your face.',
      'High pollen now. Wind is carrying exposure across this segment. Keep your mask on for the next few minutes.',
      'You are leaving the hotspot and entering a lower exposure stretch. Take a few easy breaths.',
    ]

    setError('')
    setIsDemoSpeaking(true)

    try {
      if (!Capacitor.isNativePlatform()) {
        setGlassesDemoMessage(demoMessages.join(' '))
        setError('Demo audio only speaks in the iOS app. Browser preview shows the Meta Glasses script without playing sound.')
        return
      }

      const currentStatus = await checkGlassesStatus()
      if (!currentStatus?.connected) {
        setGlassesDemoMessage(
          'iOS has not confirmed the glasses route. Running the speaker demo anyway; set iPhone audio output to Ray-Ban Meta if you do not hear it.',
        )
      }

      for (const [index, message] of demoMessages.entries()) {
        setGlassesDemoMessage(message)
        await speakGlassesAlert(message, `meta-demo:${index}:${Date.now()}`, { force: true })
        if (index < demoMessages.length - 1) {
          await delay(DEMO_SPEAKER_PAUSE_MS)
        }
      }
    } finally {
      setIsDemoSpeaking(false)
    }
  }

  async function refreshLiveConditions(point) {
    try {
      const [pollenData, weatherData] = await Promise.all([fetchPollen(point), fetchWeather(point)])
      const summary = getPollenSummary(pollenData)
      const wind = weatherData.current?.wind_speed_10m || 0
      const gust = weatherData.current?.wind_gusts_10m || 0
      const nearestHotspot = findNearestHotspot(point, selectedResult?.hotspotSegments || [])
      const livePointScore = Math.min(
        100,
        Math.round((summary.max / 5) * 76 * weatherMultiplier(weatherData) * sensitivityBoost[sensitivity]),
      )
      const score = Math.max(livePointScore, nearestHotspot?.score || 0)
      const label = riskLabel(score)
      const nearestRoutePoint = selectedRoutePath.reduce(
        (nearest, routePoint) => {
          const distance = distanceMeters(point, routePoint)
          return distance < nearest.distance ? { point: routePoint, distance } : nearest
        },
        { point: null, distance: Number.POSITIVE_INFINITY },
      )
      const currentStep = findCurrentStep(point, directions, selectedRoute)
      const upcomingHotspot = findUpcomingHotspot(point, selectedRoutePath, selectedResult?.hotspotSegments || [])
      const dominant = nearestHotspot?.dominantPollen || upcomingHotspot?.dominantPollen || summary.dominant?.name || 'pollen'
      const currentHotspotIsNear = nearestHotspot?.score >= 64 && nearestHotspot.distance <= HOTSPOT_ENTRY_METERS
      const factors = nearestHotspot?.factors?.slice(0, 2).join(' and ') || upcomingHotspot?.factors?.slice(0, 2).join(' and ')
      let glassesMessage = `${dominant} risk is ${label.label.toLowerCase()} where you are now.`
      let speechKey = ''

      if (
        upcomingHotspot &&
        upcomingHotspot.metersAway >= HOTSPOT_PREVIEW_MIN_METERS &&
        upcomingHotspot.metersAway <= HOTSPOT_PREVIEW_MAX_METERS
      ) {
        glassesMessage = `In ${metersText(upcomingHotspot.metersAway)}, you will enter a ${upcomingHotspot.label.label.toLowerCase()} ${dominant} segment. Please wear a mask or cover your face.`
        speechKey = `ahead:${upcomingHotspot.id}`
        speakGlassesAlert(glassesMessage, speechKey)
      }

      if (currentHotspotIsNear) {
        glassesMessage = `${nearestHotspot.label.label} ${dominant} now. ${factors || 'Wind and pollen conditions'} are increasing exposure here. Please wear a mask for the next few minutes.`
        speechKey = `enter:${nearestHotspot.id}:${nearestHotspot.label.label}`
        speakGlassesAlert(glassesMessage, speechKey)
        lastSpokenAlertRef.current = {
          ...lastSpokenAlertRef.current,
          wasHighRisk: true,
        }
      } else if (lastSpokenAlertRef.current.wasHighRisk && score < 42) {
        const now = Date.now()
        if (now - lastSpokenAlertRef.current.lastSafeAt > SAFE_MESSAGE_COOLDOWN_MS) {
          glassesMessage = 'You are in a lower exposure stretch now. Take a few easy breaths.'
          speechKey = `safe:${nearestHotspot?.id || 'route'}`
          speakGlassesAlert(glassesMessage, speechKey)
          lastSpokenAlertRef.current = {
            ...lastSpokenAlertRef.current,
            wasHighRisk: false,
            lastSafeAt: now,
          }
        }
      }

      setLiveStatus({
        score,
        label,
        dominant: nearestHotspot?.dominantPollen || summary.dominant?.name || 'Pollen',
        pollenDate: summary.date,
        wind,
        gust,
        checkedAt: new Date(),
        distanceFromRoute: nearestRoutePoint.distance,
        hotspotId: nearestHotspot?.id,
        currentStep,
        nearestRouteDistance: nearestRoutePoint.distance,
        nearestHotspot,
        upcomingHotspot,
        message: `Glasses update: ${glassesMessage}`,
      })
    } catch (liveError) {
      setError(readableError(liveError, 'Unable to refresh live location risk'))
    }
  }

  async function startWalking() {
    if (!navigator.geolocation) {
      setError('Geolocation is not available in this browser.')
      return
    }

    setError('')
    const currentStatus = await checkGlassesStatus()
    if (Capacitor.isNativePlatform() && currentStatus?.connected) {
      setGlassesDemoMessage(
        `${currentStatus.likelyMetaGlasses ? 'Meta glasses' : 'Bluetooth audio'} connected. Confirm you are wearing them to hear route alerts.`,
      )
    } else if (Capacitor.isNativePlatform()) {
      setGlassesDemoMessage('No Meta glasses audio route detected yet. GPS will still run, but spoken alerts need Bluetooth glasses connected.')
    }
    setIsTracking(true)
    setIsFollowMode(true)
    followModeRef.current = true
    speakGlassesAlert('Walking mode started. I will warn you before higher pollen segments.', 'walking-start')
    locationWatchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const point = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        }
        const nearestRoutePoint = findNearestRoutePoint(point, selectedRoutePath)
        const isFarFromRoute = nearestRoutePoint.distance > 500
        const displayPoint = nearestRoutePoint.distance <= 80 || isFarFromRoute ? nearestRoutePoint.point : point
        setGpsRouteWarning(
          isFarFromRoute
            ? `GPS is ${metersText(nearestRoutePoint.distance)} from this route. Showing the planned route instead.`
            : '',
        )
        setCurrentLocation(displayPoint)
        if (followModeRef.current && mapRef.current) {
          mapRef.current.panTo(displayPoint)
          if (mapRef.current.getZoom() < 17) {
            mapRef.current.setZoom(17)
          }
        }

        const nearestHotspot = findNearestHotspot(point, selectedResult?.hotspotSegments || [])
        const shouldRefresh =
          !lastLiveCheckRef.current ||
          Date.now() - lastLiveCheckRef.current.time > LIVE_REFRESH_MS ||
          distanceMeters(lastLiveCheckRef.current.point, point) > 120 ||
          nearestHotspot?.id !== lastLiveCheckRef.current.hotspotId

        if (shouldRefresh && !isFarFromRoute) {
          lastLiveCheckRef.current = { point, time: Date.now(), hotspotId: nearestHotspot?.id }
          refreshLiveConditions(point)
        }
      },
      (geoError) => {
        setIsTracking(false)
        setIsFollowMode(false)
        followModeRef.current = false
        const denied = geoError.code === geoError.PERMISSION_DENIED
        setError(
          denied
            ? 'Chrome could not access location. The site toggle looks allowed, so turn on macOS Location Services for Google Chrome specifically, reload, then try Start Walking again.'
            : geoError.message || 'Unable to read your current location.',
        )
      },
      {
        enableHighAccuracy: true,
        maximumAge: 15_000,
        timeout: 12_000,
      },
    )

    liveRefreshRef.current = window.setInterval(() => {
      if (lastLiveCheckRef.current?.point) {
        refreshLiveConditions(lastLiveCheckRef.current.point)
      }
    }, REFRESH_INTERVAL_MS)
  }

  function stopWalking() {
    if (locationWatchRef.current) navigator.geolocation.clearWatch(locationWatchRef.current)
    if (liveRefreshRef.current) window.clearInterval(liveRefreshRef.current)
    locationWatchRef.current = null
    liveRefreshRef.current = null
    setIsTracking(false)
    setIsFollowMode(false)
    setGpsRouteWarning('')
    followModeRef.current = false
  }

  function resumeFollowMode() {
    setIsFollowMode(true)
    followModeRef.current = true
    if (currentLocation && mapRef.current) {
      mapRef.current.panTo(currentLocation)
      mapRef.current.setZoom(17)
    }
  }

  async function analyzeRoute(event, options = {}) {
    event?.preventDefault()
    const silent = Boolean(options.silent)
    setError('')
    if (!silent) {
      setResults([])
      setSelectedRoute(0)
    }

    if (!GOOGLE_MAPS_KEY) {
      setError('Missing VITE_GOOGLE_MAPS_API_KEY in .env.local')
      return
    }

    if (!window.google?.maps) {
      setError('Google Maps is still loading. Try again in a moment.')
      return
    }

    try {
      if (silent) setIsRefreshing(true)
      else setStatus(mode === 'BICYCLING' ? 'Calculating bike and final-walk route alternatives' : 'Calculating route alternatives')
      const service = new window.google.maps.DirectionsService()
      const baseResponse = await service.route({
        origin,
        destination,
        travelMode: window.google.maps.TravelMode[mode],
        provideRouteAlternatives: true,
      })
      const response =
        mode === 'BICYCLING' ? await buildBikeWalkDirections(service, baseResponse, destination) : baseResponse

      setDirections(response)
      const routes = response.routes.slice(0, 3)
      const midpoint = samplePath(routes[0].overview_path, 3)[1] || DEFAULT_CENTER
      if (!silent && mapRef.current) {
        mapRef.current.panTo(midpoint)
      }

      if (!silent) setStatus('Checking wind and current weather')
      const weatherData = await fetchWeather(midpoint)
      setWeather(weatherData)

      if (!silent) setStatus('Sampling pollen, greenery, and route context')
      const scoredRoutes = []

      for (const route of routes) {
        const samplePoints = samplePath(route.overview_path, HOTSPOT_SAMPLE_COUNT)
        const pollenResults = await Promise.all(samplePoints.map(fetchCachedPollen))
        const greenerySamples = await fetchGreenerySamples(mapRef.current, samplePoints)
        const hotspotSegments = buildHotspotSegments(route, pollenResults, weatherData, sensitivity, mode, greenerySamples)
        scoredRoutes.push(scoreRoute(route, pollenResults, weatherData, sensitivity, mode, greenerySamples, hotspotSegments))
      }

      setResults(scoredRoutes)
      const bestIndex = scoredRoutes.reduce((best, route, index) => (route.score < scoredRoutes[best].score ? index : best), 0)
      if (!silent) setSelectedRoute(bestIndex)
      else setSelectedRoute((current) => Math.min(current, scoredRoutes.length - 1))
      setStatus('')
      setIsRefreshing(false)
    } catch (routeError) {
      setStatus('')
      setIsRefreshing(false)
      setError(readableError(routeError, 'Route analysis failed'))
    }
  }

  return (
    <main className={`app-shell ${selectedResult ? 'has-analysis' : ''} ${isTracking ? 'walking-active' : ''}`}>
      <section className="control-panel" aria-label="Pollen Pal trip controls">
        <div className="brand-row">
          <div className="brand-mark">
            <Trees size={22} />
          </div>
          <div>
            <p className="eyebrow">Code for Climate / Protect</p>
            <h1>Pollen Pal</h1>
          </div>
        </div>

        {isTracking && (
          <div className="mobile-trip-summary">
            <span>{mode === 'BICYCLING' ? 'Bike' : 'Walk'} route active</span>
            <strong>{destination}</strong>
            <small>Sensitivity: {sensitivity}</small>
            {gpsRouteWarning && <em>{gpsRouteWarning}</em>}
          </div>
        )}

        <form className="route-form" onSubmit={analyzeRoute}>
          <label>
            <span>Start</span>
            <input value={origin} onChange={(event) => setOrigin(event.target.value)} />
          </label>
          <label>
            <span>Destination</span>
            <input value={destination} onChange={(event) => setDestination(event.target.value)} />
          </label>

          <div className="segmented" aria-label="Travel mode">
            <button type="button" className={mode === 'WALKING' ? 'active' : ''} onClick={() => setMode('WALKING')}>
              <Navigation size={16} /> Walk
            </button>
            <button type="button" className={mode === 'BICYCLING' ? 'active' : ''} onClick={() => setMode('BICYCLING')}>
              <Bike size={16} /> Bike
            </button>
          </div>

          <label>
            <span>Sensitivity</span>
            <select value={sensitivity} onChange={(event) => setSensitivity(event.target.value)}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>

          <div className="form-actions">
            <button className="primary-action" type="submit" disabled={!isLoaded || Boolean(status)}>
              {status ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
              Analyze exposure
            </button>

            {selectedResult && !isTracking && (
              <button className="walk-action" type="button" onClick={startWalking}>
                <LocateFixed size={18} />
                Start Walking
              </button>
            )}

            {isTracking && (
              <button className="stop-action" type="button" onClick={stopWalking}>
                <LocateFixed size={18} />
                Stop Walking
              </button>
            )}
          </div>
        </form>

        {status && <p className="status">{status}...</p>}
        {(error || loadError) && (
          <div className="error-box">
            <AlertTriangle size={18} />
            <span>{error || loadError.message}</span>
          </div>
        )}

        <div className="guardrail">
          <ShieldCheck size={18} />
          <span>Guardrail: Pollen Pal gives exposure-prep guidance, not medical diagnosis or treatment.</span>
        </div>
      </section>

      <section className="map-stage" aria-label="Route map and risk results">
        <div className="map-wrap">
          {isLoaded ? (
            <GoogleMap
              defaultCenter={DEFAULT_CENTER}
              zoom={13}
              mapContainerClassName="map"
              onLoad={(map) => {
                mapRef.current = map
                map.setCenter(DEFAULT_CENTER)
              }}
              onDragStart={() => {
                if (isTracking) {
                  followModeRef.current = false
                  setIsFollowMode(false)
                }
              }}
              options={{
                disableDefaultUI: true,
                zoomControl: true,
                gestureHandling: 'greedy',
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: false,
              }}
            >
              {directions?.routes?.map((route, index) => (
                <PolylineF
                  key={route.summary || index}
                  path={route.overview_path.map(pointToLatLng)}
                  options={{
                    strokeColor: selectedRoute === index ? '#1b7f62' : '#6d7d73',
                    strokeOpacity: selectedRoute === index ? 0 : 0.45,
                    strokeWeight: selectedRoute === index ? 0 : 5,
                    zIndex: selectedRoute === index ? 3 : 1,
                  }}
                />
              ))}
              {selectedResult?.hotspotSegments?.flatMap((segment) => [
                <PolylineF
                  key={`${segment.id}-glow`}
                  path={segment.path}
                  options={{
                    strokeColor: segment.color,
                    strokeOpacity: 0.18,
                    strokeWeight: 20,
                    zIndex: 2,
                  }}
                />,
                <PolylineF
                  key={`${segment.id}-core`}
                  path={segment.path}
                  options={{
                    strokeColor: segment.color,
                    strokeOpacity: 0.76,
                    strokeWeight: 9,
                    zIndex: 3,
                  }}
                />,
              ])}
              {selectedRouteDisplaySegments.flatMap((segment) => {
                const isWalk = segment.mode === 'walk'
                const strokeColor = isWalk ? '#2563eb' : '#0f766e'
                const haloKey = `${segment.id}-halo`
                const coreKey = `${segment.id}-core`
                const dottedIcons = isWalk
                  ? [
                      {
                        icon: {
                          path: 'M 0,-1 0,1',
                          scale: segment.emphasis === 'final' ? 4.2 : 3.6,
                          strokeColor,
                          strokeOpacity: 1,
                          strokeWeight: segment.emphasis === 'final' ? 3.4 : 3,
                        },
                        offset: '0',
                        repeat: segment.emphasis === 'final' ? '12px' : '16px',
                      },
                    ]
                  : undefined

                return [
                  <PolylineF
                    key={haloKey}
                    path={segment.path}
                    options={{
                      strokeColor: '#ffffff',
                      strokeOpacity: isWalk ? 0 : 0.95,
                      strokeWeight: isWalk ? 0 : 9,
                      zIndex: 7,
                    }}
                  />,
                  <PolylineF
                    key={coreKey}
                    path={segment.path}
                    options={{
                      strokeColor,
                      strokeOpacity: isWalk ? 0 : 0.95,
                      strokeWeight: isWalk ? 0 : 5,
                      icons: dottedIcons,
                      zIndex: segment.emphasis === 'final' ? 9 : 8,
                    }}
                  />,
                ]
              })}
              {routeStart && <MarkerF position={routeStart} label="A" />}
              {directions?.routes?.[selectedRoute]?.dismountPoint && (
                <MarkerF position={directions.routes[selectedRoute].dismountPoint} label="P" />
              )}
              {routeEnd && <MarkerF position={routeEnd} label="B" />}
              {showGreenLayer &&
                selectedResult?.greenerySamples?.map((sample, index) => (
                  <CircleF
                    key={`${sample.lat}-${sample.lng}-${index}`}
                    center={{ lat: sample.lat, lng: sample.lng }}
                    radius={sample.count > 0 ? 55 + sample.count * 10 : 35}
                    options={{
                      fillColor: sample.count > 0 ? '#2f8f4e' : '#9ead9e',
                      fillOpacity: sample.count > 0 ? 0.1 : 0.04,
                      strokeColor: sample.count > 0 ? '#2f8f4e' : '#9ead9e',
                      strokeOpacity: 0.22,
                      strokeWeight: 1,
                    }}
                  />
                ))}
              {currentLocation && (
                <MarkerF
                  position={currentLocation}
                  icon={{
                    path: window.google.maps.SymbolPath.CIRCLE,
                    scale: 9,
                    fillColor: '#2d7ff9',
                    fillOpacity: 1,
                    strokeColor: '#ffffff',
                    strokeWeight: 4,
                  }}
                />
              )}
            </GoogleMap>
          ) : (
            <div className="map-loading">
              <Loader2 className="spin" />
              Loading map
            </div>
          )}
          {showWindLayer && weather && (
            <div className="wind-compass" aria-label="Wind direction">
              <span>Wind</span>
              <strong>{Math.round(weather.current.wind_speed_10m)} mph</strong>
              <div
                className="wind-arrow"
                style={{
                  '--wind-angle': `${weather.current.wind_direction_10m || 0}deg`,
                }}
              >
                ↑
              </div>
            </div>
          )}
          {selectedResult?.hotspotSegments?.length > 0 && (
            <div className="heat-legend" aria-label="Route pollen exposure heatmap legend">
              <span>Route exposure</span>
              <div className="legend-ramp" />
              <small>Lower to very high</small>
            </div>
          )}
          {isTracking && !isFollowMode && (
            <button className="recenter-follow-button" type="button" onClick={resumeFollowMode}>
              <LocateFixed size={18} />
              Re-center
            </button>
          )}
          <div className="bottom-layer-bar" aria-label="Map display toggles">
            <button
              type="button"
              className={showWindLayer ? 'active' : ''}
              onClick={() => setShowWindLayer((current) => !current)}
            >
              <Wind size={16} />
              Wind
            </button>
            <button
              type="button"
              className={showGreenLayer ? 'active' : ''}
              onClick={() => setShowGreenLayer((current) => !current)}
            >
              <MapPin size={16} />
              Parks
            </button>
          </div>
        </div>

        <div className="insight-panel">
          <div className="refresh-row">
            <Clock size={16} />
            <span>
              Pollen forecast:{' '}
              {selectedResult?.pollenUnavailable
                ? 'Unavailable for this location'
                : formatPollenDate(selectedResult?.pollenSummaries?.[0]?.date)}{' '}
              · Weather:{' '}
              {weather?.current?.time ? new Date(weather.current.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--'}
            </span>
            <button type="button" onClick={() => analyzeRoute(null, { silent: true })} disabled={!directions || isRefreshing}>
              {isRefreshing ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            </button>
          </div>
          <div className="weather-row">
            <div>
              <span className="metric-label">Wind</span>
              <strong>{weather ? `${Math.round(weather.current.wind_speed_10m)} mph` : '--'}</strong>
            </div>
            <div>
              <span className="metric-label">Gust</span>
              <strong>{weather ? `${Math.round(weather.current.wind_gusts_10m)} mph` : '--'}</strong>
            </div>
            <div>
              <span className="metric-label">Humidity</span>
              <strong>{weather ? `${weather.current.relative_humidity_2m}%` : '--'}</strong>
            </div>
          </div>

          {selectedResult ? (
            <>
              <div className={`score-card ${selectedResult.label.tone}`}>
                <div>
                  <span className="metric-label">Selected route risk</span>
                  <strong>{selectedResult.label.label}</strong>
                </div>
                <div className="score-ring">{selectedResult.score}</div>
              </div>

              <div className="route-options">
                {results.map((result, index) => (
                  <button
                    key={`${result.score}-${index}`}
                    type="button"
                    className={selectedRoute === index ? 'selected' : ''}
                    onClick={() => setSelectedRoute(index)}
                  >
                    <MapPin size={16} />
                    <span>{result.mixedMode ? `Bike+Walk ${index + 1}` : `Route ${index + 1}`}</span>
                    <strong>{result.score}</strong>
                  </button>
                ))}
              </div>

              {liveStatus && (
                <div className={`live-card ${liveStatus.label.tone}`}>
                  <div>
                    <span className="metric-label">
                      Live GPS glasses alert · {glassesStatus.connected ? glassesStatus.routeName || 'Bluetooth audio' : 'not connected'}
                    </span>
                    <strong>{liveStatus.label.label}</strong>
                  </div>
                  <p>{liveStatus.message}</p>
                  <small>
                    Wind {Math.round(liveStatus.wind)} mph · Checked{' '}
                    {liveStatus.checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </small>
                </div>
              )}

              <div className="advice">
                <h2>Pollen Pal says</h2>
                {advice.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>

              <div className="alert-strip">
                <Glasses size={18} />
                <div className="glasses-status-copy">
                  <span>
                    {Capacitor.isNativePlatform()
                      ? glassesStatus.connected
                        ? `${glassesStatus.likelyMetaGlasses ? 'Meta glasses' : 'Bluetooth audio'} connected: ${glassesStatus.routeName || 'iOS route'}. Pollen Pal will speak route-risk alerts while walking.`
                        : glassesWearConfirmed
                          ? 'Meta Glasses marked as worn. iOS has not confirmed the route, so set iPhone audio output to Ray-Ban Meta if you do not hear alerts.'
                          : 'iOS has not confirmed Meta Glasses audio yet. Pair them, select them in iPhone audio output, or mark that you are wearing them for demo mode.'
                      : 'Browser preview is quiet. iOS will speak alerts through connected Ray-Ban Meta Bluetooth audio.'}
                  </span>
                  {glassesDemoMessage && <small>{glassesDemoMessage}</small>}
                  <div className="glasses-actions">
                    {Capacitor.isNativePlatform() && (
                      <button
                        type="button"
                        className={glassesWearConfirmed ? 'confirmed' : ''}
                        onClick={() => setGlassesWearConfirmed((current) => !current)}
                      >
                        {glassesWearConfirmed ? 'Meta Glasses are on' : "I'm wearing Meta Glasses"}
                      </button>
                    )}
                    <button type="button" onClick={testGlassesAudio}>
                      Test audio
                    </button>
                    <button type="button" onClick={runMetaGlassesDemo} disabled={isDemoSpeaking}>
                      {isDemoSpeaking ? 'Playing demo' : 'Demo speaker'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="plant-list">
                <h2>Likely triggers</h2>
                {selectedResult.pollenSummaries[0]?.plants?.length ? (
                  selectedResult.pollenSummaries[0].plants.map((plant) => (
                    <div className="plant-item" key={plant.name}>
                      <span>{plant.name}</span>
                      <strong>{plant.value}/5</strong>
                    </div>
                  ))
                ) : (
                  <p>No high plant-specific trigger returned for this point.</p>
                )}
              </div>

              <div className="plant-list">
                <h2>Greenery context</h2>
                {selectedResult.greenerySamples?.some((sample) => sample.count > 0) ? (
                  selectedResult.greenerySamples
                    .filter((sample) => sample.count > 0)
                    .slice(0, 3)
                    .map((sample, index) => (
                      <div className="plant-item" key={`${sample.lat}-${sample.lng}`}>
                        <span>{sample.names[0] || `Park cluster ${index + 1}`}</span>
                        <strong>{sample.count}</strong>
                      </div>
                    ))
                ) : (
                  <p>No nearby parks detected along sampled route points.</p>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <Wind size={22} />
              <h2>Ready for the first analysis</h2>
              <p>Run one walking or biking trip to compare route-level pollen exposure.</p>
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

function App() {
  if (!GOOGLE_MAPS_KEY) {
    return <MissingKeyApp />
  }

  return <PollenPalApp />
}

export default App
