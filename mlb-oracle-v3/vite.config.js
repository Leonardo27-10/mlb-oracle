import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/mlb-api': {
        target: 'https://statsapi.mlb.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mlb-api/, '/api/v1'),
      }
    }
  }
})
