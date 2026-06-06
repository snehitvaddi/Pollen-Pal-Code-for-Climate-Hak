import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function pollenProxy() {
  return {
    name: 'pollen-pal-pollen-proxy',
    configureServer(server) {
      server.middlewares.use('/api/pollen', async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const latitude = url.searchParams.get('lat')
        const longitude = url.searchParams.get('lng')
        const days = url.searchParams.get('days') || '1'
        const apiKey = process.env.GOOGLE_POLLEN_API_KEY

        res.setHeader('Content-Type', 'application/json')

        if (!apiKey) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Missing GOOGLE_POLLEN_API_KEY in .env.local' }))
          return
        }

        if (!latitude || !longitude) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'lat and lng are required' }))
          return
        }

        try {
          const pollenUrl = new URL('https://pollen.googleapis.com/v1/forecast:lookup')
          pollenUrl.searchParams.set('key', apiKey)
          pollenUrl.searchParams.set('location.latitude', latitude)
          pollenUrl.searchParams.set('location.longitude', longitude)
          pollenUrl.searchParams.set('days', days)
          pollenUrl.searchParams.set('plantsDescription', 'true')

          const pollenResponse = await fetch(pollenUrl)
          const body = await pollenResponse.text()
          res.statusCode = pollenResponse.status
          res.end(body)
        } catch (error) {
          res.statusCode = 502
          res.end(JSON.stringify({ error: 'Unable to fetch Google Pollen data', detail: error.message }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))

  return {
    base: './',
    plugins: [react(), pollenProxy()],
  }
})
