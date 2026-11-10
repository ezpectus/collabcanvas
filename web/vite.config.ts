import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server: the API runs on :5237 locally; /hubs needs the ws proxy
// flag for SignalR websockets.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/hubs': { target: 'http://localhost:5237', ws: true },
      '/health': { target: 'http://localhost:5237' },
      '/docs': { target: 'http://localhost:5237' },
    },
  },
})
